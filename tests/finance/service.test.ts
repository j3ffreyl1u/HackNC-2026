import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BankingAdapter } from '../../src/finance/bank.js';
import type { HouseholdConfig, OutboundMessage } from '../../src/contracts/index.js';
import {
  FinanceConfigError,
  createFinanceService,
  type FinanceService,
} from '../../src/finance/index.js';
import { MockBank } from '../../src/finance/mock-bank.js';
import { LedgerStore } from '../../src/finance/store.js';

const config: HouseholdConfig = {
  householdId: 'demo-house',
  groupSpaceId: 'space-1',
  designatedPayerId: 'mason',
  householdAccountId: 'placeholder-house',
  members: [
    { userId: 'mason', displayName: 'Mason', providerUserId: 'p-mason', bankAccountId: 'placeholder-mason' },
    { userId: 'alex', displayName: 'Alex', providerUserId: 'p-alex', bankAccountId: 'placeholder-alex' },
    { userId: 'jordan', displayName: 'Jordan', providerUserId: 'p-jordan', bankAccountId: 'placeholder-jordan' },
  ],
  recipients: [{ recipientId: 'electric', displayName: 'Power Co', bankAccountId: 'placeholder-electric' }],
  demoCycles: [
    { cycleId: '2026-10', bills: [{ title: 'Electricity', amountCents: 14_400, dueDate: '2026-10-15', recipientId: 'electric' }] },
    { cycleId: '2026-11', bills: [{ title: 'Electricity', amountCents: 15_000, dueDate: '2026-11-15', recipientId: 'electric' }] },
  ],
};

let store: LedgerStore;
let bank: MockBank;
let service: FinanceService;
let counter = 0;

function build(overrideBank?: BankingAdapter): FinanceService {
  return createFinanceService({
    store,
    bank: overrideBank ?? bank,
    clock: { now: () => new Date('2026-10-10T12:00:00.000Z') },
    newId: (prefix) => `${prefix}-${++counter}`,
  });
}

beforeEach(() => {
  store = LedgerStore.open(':memory:');
  bank = new MockBank();
  service = build();
});
afterEach(() => store.close());

describe('bootstrapHousehold', () => {
  it('stores enrollment and starts at the first configured cycle', async () => {
    await service.bootstrapHousehold(config);
    expect(store.getHouseholdConfig('demo-house')).toEqual(config);
    expect(store.getMeta('demo-house', 'current_cycle')).toBe('2026-10');
  });

  it('is idempotent and does not rewind the cycle or disturb ledger state', async () => {
    await service.bootstrapHousehold(config);
    store.setMeta('demo-house', 'current_cycle', '2026-11');
    store.claimInbound('evt-1', '2026-10-10T12:00:00.000Z');
    store.completeInbound('evt-1', '2026-10-10T12:00:00.000Z');
    await service.bootstrapHousehold(config);
    await service.bootstrapHousehold(config);
    expect(store.getMeta('demo-house', 'current_cycle')).toBe('2026-11');
    expect(await service.claimInbound('evt-1')).toBe(false);
    expect(store.memberIds('demo-house')).toEqual(['mason', 'alex', 'jordan']);
  });

  it.each([
    ['fewer than three members', { ...config, members: config.members.slice(0, 2) }],
    ['duplicate member IDs', { ...config, members: [config.members[0], config.members[0], config.members[2]] }],
    ['a payer outside the household', { ...config, designatedPayerId: 'stranger' }],
    ['a bill with a fractional amount', { ...config, demoCycles: [{ cycleId: 'c', bills: [{ title: 'x', amountCents: 10.5, dueDate: 'd', recipientId: 'electric' }] }] }],
    ['a bill for an unknown recipient', { ...config, demoCycles: [{ cycleId: 'c', bills: [{ title: 'x', amountCents: 100, dueDate: 'd', recipientId: 'ghost' }] }] }],
    ['an empty group space', { ...config, groupSpaceId: ' ' }],
  ])('rejects %s without writing anything', async (_name, bad) => {
    await expect(service.bootstrapHousehold(bad as HouseholdConfig)).rejects.toThrow(FinanceConfigError);
    expect(store.getHouseholdConfig('demo-house')).toBeNull();
  });
});

describe('seedDemoBanking', () => {
  it('provisions accounts with the canonical starting balances and returns resolved IDs', async () => {
    const seeded = await service.seedDemoBanking(config);
    for (const m of seeded.members) {
      expect(m.bankAccountId).not.toContain('placeholder');
      expect(await bank.getBalance(m.bankAccountId)).toBe(100_000);
    }
    expect(await bank.getBalance(seeded.householdAccountId)).toBe(0);
    expect(await bank.getBalance(seeded.recipients[0].bankAccountId)).toBe(0);
    expect(seeded.demoCycles).toEqual(config.demoCycles);
  });

  it('gives every account a distinct ID', async () => {
    const seeded = await service.seedDemoBanking(config);
    const ids = [...seeded.members.map((m) => m.bankAccountId), seeded.householdAccountId, ...seeded.recipients.map((r) => r.bankAccountId)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reuses the existing mapping and never creates additional accounts on repeat', async () => {
    const first = await service.seedDemoBanking(config);
    await bank.submitTransfer({
      operationId: 'op',
      fromAccountId: first.members[0].bankAccountId,
      toAccountId: first.householdAccountId,
      amountCents: 4_800,
      description: 'x',
    });
    const second = await service.seedDemoBanking(config);
    expect(second).toEqual(first);
    // Existing balances are preserved, not reset to the starting amounts.
    expect(await bank.getBalance(first.members[0].bankAccountId)).toBe(95_200);
    expect(await bank.getBalance(first.householdAccountId)).toBe(4_800);
  });

  it('keeps the mapping across a service restart on the same ledger', async () => {
    const first = await service.seedDemoBanking(config);
    const restarted = build();
    expect(await restarted.seedDemoBanking(config)).toEqual(first);
  });

  it('refuses to seed through a bank that cannot provision accounts', async () => {
    const readOnlyBank: BankingAdapter = {
      getBalance: async () => 0,
      submitTransfer: async () => ({ status: 'failed' }),
      getTransfer: async () => ({ status: 'unknown' }),
      findTransfer: async () => null,
    };
    await expect(build(readOnlyBank).seedDemoBanking(config)).rejects.toThrow(FinanceConfigError);
  });
});

describe('durable inbound and outbox', () => {
  const message = (deliveryId: string, extra: Partial<OutboundMessage> = {}): OutboundMessage => ({
    deliveryId,
    householdId: 'demo-house',
    audience: { kind: 'private', userId: 'jordan' },
    text: 'hello',
    ...extra,
  });

  it('claims inbound events until they are completed', async () => {
    expect(await service.claimInbound('evt-1')).toBe(true);
    expect(await service.claimInbound('evt-1')).toBe(true);
    await service.completeInbound('evt-1');
    expect(await service.claimInbound('evt-1')).toBe(false);
  });

  it('queues messages once and drops them from pending after delivery', async () => {
    await service.enqueueMessage(message('d-1'));
    await service.enqueueMessage(message('d-1'));
    await service.enqueueMessage(message('d-2'));
    expect((await service.pendingMessages()).map((m) => m.deliveryId)).toEqual(['d-1', 'd-2']);
    await service.recordDelivery('d-1', 'prov-1');
    expect((await service.pendingMessages()).map((m) => m.deliveryId)).toEqual(['d-2']);
  });

  it('resolves a delivered proposal message back to its proposal version', async () => {
    store.upsertHousehold(config);
    store.db
      .prepare(
        `INSERT INTO proposals (proposal_id, household_id, bill_id, purpose, version, status, amount_cents,
           source_account_id, destination_account_id, required_actor_ids, allocation_json, description, created_at, updated_at)
         VALUES ('prop-1', 'demo-house', 'bill-1', 'contribution', 3, 'proposed', 4800, 'a', 'b', '[]', '{}', 'd', 't', 't')`,
      )
      .run();
    await service.enqueueMessage(message('d-1', { proposalRef: { proposalId: 'prop-1', proposalVersion: 3 } }));
    await service.recordDelivery('d-1', 'prov-77');
    expect(await service.lookupProposal('prov-77')).toEqual({ proposalId: 'prop-1', proposalVersion: 3 });
    expect(await service.lookupProposal('unrelated-message')).toBeNull();
  });
});

describe('close', () => {
  it('closes the underlying database', async () => {
    await service.close();
    expect(store.db.open).toBe(false);
  });
});
