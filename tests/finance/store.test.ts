import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HouseholdConfig, OutboundMessage } from '../../src/contracts/index.js';
import { LedgerStore } from '../../src/finance/store.js';

const NOW = '2026-10-10T12:00:00.000Z';

const config: HouseholdConfig = {
  householdId: 'demo-house',
  groupSpaceId: 'space-1',
  designatedPayerId: 'mason',
  householdAccountId: 'acct-house',
  members: [
    { userId: 'mason', displayName: 'Mason', providerUserId: 'p-mason', bankAccountId: 'acct-mason' },
    { userId: 'alex', displayName: 'Alex', providerUserId: 'p-alex', bankAccountId: 'acct-alex' },
    { userId: 'jordan', displayName: 'Jordan', providerUserId: 'p-jordan', bankAccountId: 'acct-jordan' },
  ],
  recipients: [{ recipientId: 'electric', displayName: 'Power Co', bankAccountId: 'acct-electric' }],
  demoCycles: [
    { cycleId: '2026-10', bills: [{ title: 'Electricity', amountCents: 14_400, dueDate: '2026-10-15', recipientId: 'electric' }] },
  ],
};

function addProposal(store: LedgerStore, proposalId = 'prop-1'): void {
  store.db
    .prepare(
      `INSERT INTO proposals (proposal_id, household_id, bill_id, purpose, version, status, amount_cents,
         source_account_id, destination_account_id, required_actor_ids, allocation_json, description, created_at, updated_at)
       VALUES (?, 'demo-house', 'bill-1', 'contribution', 1, 'proposed', 4800, 'acct-mason', 'acct-house',
         '["mason"]', '{}', 'Mason pays $48', ?, ?)`,
    )
    .run(proposalId, NOW, NOW);
}

const operation = (operationId = 'op-1') => ({
  operationId,
  householdId: 'demo-house',
  proposalId: 'prop-1',
  proposalVersion: 1,
  fromAccountId: 'acct-mason',
  toAccountId: 'acct-house',
  amountCents: 4_800,
  description: 'October electricity share',
});

const message = (deliveryId: string, extra: Partial<OutboundMessage> = {}): OutboundMessage => ({
  deliveryId,
  householdId: 'demo-house',
  audience: { kind: 'group', spaceId: 'space-1' },
  text: `message ${deliveryId}`,
  ...extra,
});

let store: LedgerStore;
beforeEach(() => {
  store = LedgerStore.open(':memory:');
  store.upsertHousehold(config);
});
afterEach(() => store.close());

describe('migrations and transactions', () => {
  it('applies the schema and records the version', () => {
    expect(store.schemaVersion()).toBe(3);
  });

  it('rolls back every change when a transaction throws', () => {
    expect(() =>
      store.tx(() => {
        store.setMeta('demo-house', 'cycle', '2026-11');
        store.enqueueOutbox(message('d-1'), NOW);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.getMeta('demo-house', 'cycle')).toBeNull();
    expect(store.pendingOutbox()).toEqual([]);
  });

  it('enforces foreign keys', () => {
    expect(() => store.recordApproval('missing-proposal', 1, 'mason', NOW)).toThrow();
  });
});

describe('households', () => {
  it('stores enrollment and keeps member order stable', () => {
    expect(store.memberIds('demo-house')).toEqual(['mason', 'alex', 'jordan']);
    expect(store.getHouseholdConfig('demo-house')).toEqual(config);
    expect(store.getHouseholdConfig('other')).toBeNull();
  });

  it('upserting again is idempotent and preserves ledger state', () => {
    store.setMeta('demo-house', 'cycle', '2026-10');
    addProposal(store);
    store.recordApproval('prop-1', 1, 'mason', NOW);
    store.upsertHousehold(config);
    store.upsertHousehold(config);
    expect(store.memberIds('demo-house')).toEqual(['mason', 'alex', 'jordan']);
    expect(store.getMeta('demo-house', 'cycle')).toBe('2026-10');
    expect(store.approvalsFor('prop-1', 1)).toEqual(['mason']);
  });
});

describe('inbound events and commands', () => {
  it('claims a new event, and a received-but-unfinished event stays claimable', () => {
    expect(store.claimInbound('evt-1', NOW)).toBe(true);
    expect(store.claimInbound('evt-1', NOW)).toBe(true);
  });

  it('refuses an event once it is processed', () => {
    store.claimInbound('evt-1', NOW);
    store.completeInbound('evt-1', NOW);
    expect(store.claimInbound('evt-1', NOW)).toBe(false);
  });

  it('completing an event that was never claimed still marks it processed', () => {
    store.completeInbound('evt-2', NOW);
    expect(store.claimInbound('evt-2', NOW)).toBe(false);
  });

  it('records a command exactly once', () => {
    expect(store.markCommandProcessed('cmd-1', 'demo-house', 'accepted', NOW)).toBe(true);
    expect(store.markCommandProcessed('cmd-1', 'demo-house', 'accepted', NOW)).toBe(false);
    expect(store.isCommandProcessed('cmd-1')).toBe(true);
    expect(store.isCommandProcessed('cmd-2')).toBe(false);
  });
});

describe('approvals and settlements', () => {
  beforeEach(() => addProposal(store));

  it('records one approval per proposal, version and actor', () => {
    expect(store.recordApproval('prop-1', 1, 'mason', NOW)).toBe(true);
    expect(store.recordApproval('prop-1', 1, 'mason', NOW)).toBe(false);
    expect(store.recordApproval('prop-1', 2, 'mason', NOW)).toBe(true);
    expect(store.recordApproval('prop-1', 1, 'alex', NOW)).toBe(true);
    expect(store.approvalsFor('prop-1', 1)).toEqual(['alex', 'mason']);
    expect(store.approvalsFor('prop-1', 2)).toEqual(['mason']);
  });

  it('allows a single settlement per debt', () => {
    store.db
      .prepare(
        `INSERT INTO debts (debt_id, household_id, debtor_id, creditor_id, original_cents, remaining_cents, source_bill_id, created_at)
         VALUES ('debt-1', 'demo-house', 'jordan', 'alex', 4800, 4800, 'bill-1', ?)`,
      )
      .run(NOW);
    expect(store.createSettlement('set-1', 'debt-1', '2026-11', 4_800, NOW)).toBe(true);
    expect(store.createSettlement('set-2', 'debt-1', '2026-12', 4_800, NOW)).toBe(false);
    const rows = store.db.prepare('SELECT settlement_id FROM settlements').all();
    expect(rows).toEqual([{ settlement_id: 'set-1' }]);
  });

  it('rejects a debt whose remaining amount exceeds the original', () => {
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO debts (debt_id, household_id, debtor_id, creditor_id, original_cents, remaining_cents, source_bill_id, created_at)
           VALUES ('debt-x', 'demo-house', 'jordan', 'alex', 4800, 4801, 'bill-1', ?)`,
        )
        .run(NOW),
    ).toThrow();
  });
});

describe('bank operations', () => {
  beforeEach(() => addProposal(store));

  it('persists as prepared before any bank call, and rejects a duplicate operationId', () => {
    store.insertBankOperation(operation(), NOW);
    expect(store.getBankOperation('op-1')).toMatchObject({ operationId: 'op-1', status: 'prepared', amountCents: 4_800 });
    expect(() => store.insertBankOperation(operation(), NOW)).toThrow();
  });

  it('records the provider ID and keeps it across later updates without one', () => {
    store.insertBankOperation(operation(), NOW);
    store.updateBankOperation('op-1', { status: 'submitted', providerTransactionId: 'tx-9' }, NOW);
    store.updateBankOperation('op-1', { status: 'unknown', reason: 'timeout' }, NOW);
    expect(store.getBankOperation('op-1')).toMatchObject({
      status: 'unknown',
      providerTransactionId: 'tx-9',
      reason: 'timeout',
    });
  });

  it('lists only unresolved operations, oldest first', () => {
    for (const id of ['op-1', 'op-2', 'op-3', 'op-4']) store.insertBankOperation(operation(id), NOW);
    store.updateBankOperation('op-1', { status: 'confirmed', providerTransactionId: 't1' }, NOW);
    store.updateBankOperation('op-2', { status: 'failed', reason: 'rejected' }, NOW);
    store.updateBankOperation('op-4', { status: 'unknown' }, NOW);
    expect(store.unresolvedBankOperations('demo-house').map((o) => o.operationId)).toEqual(['op-3', 'op-4']);
    expect(store.unresolvedBankOperations().map((o) => o.operationId)).toEqual(['op-3', 'op-4']);
    expect(store.unresolvedBankOperations('other-house')).toEqual([]);
  });

  it('throws when updating an operation that does not exist', () => {
    expect(() => store.updateBankOperation('nope', { status: 'failed' }, NOW)).toThrow();
  });

  it('rejects non-positive amounts', () => {
    expect(() => store.insertBankOperation({ ...operation(), amountCents: 0 }, NOW)).toThrow();
  });
});

describe('outbox and provider bindings', () => {
  it('delivers in enqueue order and never double-queues a deliveryId', () => {
    expect(store.enqueueOutbox(message('d-1'), NOW)).toBe(true);
    expect(store.enqueueOutbox(message('d-2', { audience: { kind: 'private', userId: 'jordan' } }), NOW)).toBe(true);
    expect(store.enqueueOutbox(message('d-1', { text: 'retry' }), NOW)).toBe(false);
    const pending = store.pendingOutbox();
    expect(pending.map((m) => m.deliveryId)).toEqual(['d-1', 'd-2']);
    expect(pending[0].text).toBe('message d-1');
    expect(pending[1].audience).toEqual({ kind: 'private', userId: 'jordan' });
  });

  it('removes a message from pending once delivery is recorded', () => {
    store.enqueueOutbox(message('d-1'), NOW);
    store.recordDelivery('d-1', 'prov-1');
    expect(store.pendingOutbox()).toEqual([]);
  });

  it('binds the provider message ID to the proposal version for reactions', () => {
    addProposal(store);
    store.enqueueOutbox(message('d-1', { proposalRef: { proposalId: 'prop-1', proposalVersion: 1 } }), NOW);
    expect(store.pendingOutbox()[0].proposalRef).toEqual({ proposalId: 'prop-1', proposalVersion: 1 });
    store.recordDelivery('d-1', 'prov-1');
    expect(store.lookupProviderBinding('prov-1')).toEqual({ proposalId: 'prop-1', proposalVersion: 1 });
    expect(store.lookupProviderBinding('some-other-message')).toBeNull();
  });

  it('holds an uncertain delivery out of the pending list instead of resending', () => {
    store.enqueueOutbox(message('d-1'), NOW);
    store.markDeliveryUncertain('d-1');
    expect(store.pendingOutbox()).toEqual([]);
  });

  it('rejects recording a delivery for an unknown deliveryId', () => {
    expect(() => store.recordDelivery('ghost', 'prov-1')).toThrow();
  });
});

describe('durability across reopen', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'splitbot-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('retains operations, debts, events, commands, approvals and the outbox after reopening', () => {
    const path = join(dir, 'ledger.sqlite');
    const first = LedgerStore.open(path);
    first.upsertHousehold(config);
    addProposal(first);
    first.insertBankOperation(operation(), NOW);
    first.updateBankOperation('op-1', { status: 'confirmed', providerTransactionId: 'tx-1' }, NOW);
    first.insertBankOperation(operation('op-2'), NOW);
    first.updateBankOperation('op-2', { status: 'unknown', reason: 'timeout' }, NOW);
    first.db
      .prepare(
        `INSERT INTO debts (debt_id, household_id, debtor_id, creditor_id, original_cents, remaining_cents, source_bill_id, created_at)
         VALUES ('debt-1', 'demo-house', 'jordan', 'alex', 4800, 4800, 'bill-1', ?)`,
      )
      .run(NOW);
    first.recordApproval('prop-1', 1, 'mason', NOW);
    first.markCommandProcessed('cmd-1', 'demo-house', 'accepted', NOW);
    first.claimInbound('evt-1', NOW);
    first.completeInbound('evt-1', NOW);
    first.enqueueOutbox(message('d-1'), NOW);
    first.close();

    const second = LedgerStore.open(path);
    expect(second.schemaVersion()).toBe(3);
    expect(second.getBankOperation('op-1')).toMatchObject({ status: 'confirmed', providerTransactionId: 'tx-1' });
    expect(second.unresolvedBankOperations().map((o) => o.operationId)).toEqual(['op-2']);
    expect(second.db.prepare("SELECT remaining_cents AS c FROM debts WHERE debt_id = 'debt-1'").get()).toEqual({ c: 4_800 });
    expect(second.approvalsFor('prop-1', 1)).toEqual(['mason']);
    expect(second.isCommandProcessed('cmd-1')).toBe(true);
    expect(second.claimInbound('evt-1', NOW)).toBe(false);
    expect(second.pendingOutbox().map((m) => m.deliveryId)).toEqual(['d-1']);
    // Re-enrolling after restart keeps everything.
    second.upsertHousehold(config);
    expect(second.getBankOperation('op-2')?.status).toBe('unknown');
    second.close();
  });

  it('refuses a database written by a newer schema', () => {
    const path = join(dir, 'future.sqlite');
    const first = LedgerStore.open(path);
    first.db.pragma('user_version = 99');
    first.close();
    expect(() => LedgerStore.open(path)).toThrow(/newer than this build/);
  });
});
