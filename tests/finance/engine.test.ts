import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command, CommandPayload, ExecuteResult, HouseholdConfig } from '../../src/contracts/index.js';
import { createFinanceService, type FinanceService } from '../../src/finance/index.js';
import { Ledger } from '../../src/finance/ledger.js';
import { MockBank } from '../../src/finance/mock-bank.js';
import { LedgerStore } from '../../src/finance/store.js';

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
  demoCycles: [{ cycleId: '2026-10', bills: [] }, { cycleId: '2026-11', bills: [] }],
};

const NOW = '2026-10-10T12:00:00.000Z';

let store: LedgerStore;
let bank: MockBank;
let ledger: Ledger;
let service: FinanceService;
let idCounter: number;
let cmdCounter: number;

beforeEach(async () => {
  store = LedgerStore.open(':memory:');
  bank = new MockBank({ balances: { 'acct-mason': 100_000, 'acct-alex': 100_000, 'acct-jordan': 100_000 } });
  ledger = new Ledger(store);
  idCounter = 0;
  cmdCounter = 0;
  service = createFinanceService({
    store,
    bank,
    clock: { now: () => new Date(NOW) },
    newId: (prefix) => `${prefix}-${++idCounter}`,
  });
  await service.bootstrapHousehold(config);
});
afterEach(() => store.close());

function run(actorId: string, payload: CommandPayload, commandId = `cmd-${++cmdCounter}`): Promise<ExecuteResult> {
  const command: Command = { commandId, actorId, householdId: 'demo-house', sourceEventId: `evt-${commandId}`, payload };
  return service.execute(command);
}

const electricity = (overrides: Record<string, unknown> = {}): CommandPayload =>
  ({
    kind: 'add_bill',
    amountCents: 14_400,
    title: 'Electricity',
    dueDate: '2026-10-15',
    recipientId: 'electric',
    cycleId: '2026-10',
    ...overrides,
  }) as CommandPayload;

async function addElectricity(): Promise<{ billId: string; proposalIds: Record<string, string> }> {
  expect(await run('mason', electricity())).toEqual({ kind: 'accepted' });
  const bill = ledger.billsForCycle('demo-house', '2026-10')[0];
  const proposalIds = Object.fromEntries(ledger.proposalsForBill(bill.billId).map((p) => [p.requiredActorIds[0], p.proposalId]));
  return { billId: bill.billId, proposalIds };
}

const counts = () => ({
  bills: (store.db.prepare('SELECT COUNT(*) AS n FROM bills').get() as { n: number }).n,
  proposals: (store.db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n,
  approvals: (store.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n,
  outbox: store.pendingOutbox().length,
  commands: (store.db.prepare('SELECT COUNT(*) AS n FROM processed_commands').get() as { n: number }).n,
});

describe('add_bill', () => {
  it('creates the canonical three 4,800-cent contribution requests', async () => {
    const { billId } = await addElectricity();
    expect(ledger.bill(billId)).toMatchObject({ amountCents: 14_400, status: 'collecting', cycleId: '2026-10' });
    expect(ledger.obligations(billId)).toEqual({ mason: 4_800, alex: 4_800, jordan: 4_800 });

    const proposals = ledger.proposalsForBill(billId);
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p).toMatchObject({
        purpose: 'contribution',
        version: 1,
        status: 'proposed',
        amountCents: 4_800,
        destinationAccountId: 'acct-house',
      });
      expect(p.requiredActorIds).toHaveLength(1);
      expect(p.allocation).toEqual([
        { payerId: p.requiredActorIds[0], beneficiaryId: p.requiredActorIds[0], amountCents: 4_800, kind: 'own' },
      ]);
    }
    expect(proposals.map((p) => p.sourceAccountId).sort()).toEqual(['acct-alex', 'acct-jordan', 'acct-mason']);
  });

  it('allocates remainder cents in configured order (100 -> 34/33/33) and always sums to the bill', async () => {
    expect(await run('mason', electricity({ amountCents: 100 }))).toEqual({ kind: 'accepted' });
    const bill = ledger.billsForCycle('demo-house', '2026-10')[0];
    expect(ledger.obligations(bill.billId)).toEqual({ mason: 34, alex: 33, jordan: 33 });
    const total = ledger.proposalsForBill(bill.billId).reduce((sum, p) => sum + p.amountCents, 0);
    expect(total).toBe(100);
  });

  it('posts one group request per proposal, bound to that proposal and version', async () => {
    const { proposalIds } = await addElectricity();
    const messages = store.pendingOutbox();
    expect(messages).toHaveLength(3);
    for (const m of messages) {
      expect(m.audience).toEqual({ kind: 'group', spaceId: 'space-1' });
      expect(m.proposalRef?.proposalVersion).toBe(1);
      expect(Object.values(proposalIds)).toContain(m.proposalRef?.proposalId);
      expect(m.text).toContain('$48.00');
      expect(m.text).toContain('$144.00');
      expect(m.text).toContain(`approve ${m.proposalRef!.proposalId} v1`);
      expect(m.text.toLowerCase()).not.toContain('card');
    }
  });

  it('names Alex-only text only on Alex\'s own request', async () => {
    const { proposalIds } = await addElectricity();
    const alexMessage = store.pendingOutbox().find((m) => m.proposalRef?.proposalId === proposalIds.alex)!;
    expect(alexMessage.text).toContain("Alex's share");
    expect(alexMessage.text).not.toContain("Jordan's share");
  });

  it.each([
    ['zero amount', { amountCents: 0 }, 'INVALID_AMOUNT'],
    ['negative amount', { amountCents: -100 }, 'INVALID_AMOUNT'],
    ['fractional cents', { amountCents: 144.5 }, 'INVALID_AMOUNT'],
    ['NaN', { amountCents: Number.NaN }, 'INVALID_AMOUNT'],
    ['unknown recipient', { recipientId: 'landlord' }, 'UNKNOWN_RESOURCE'],
    ['blank title', { title: '   ' }, 'AMBIGUOUS_ACTION'],
    ['malformed date', { dueDate: '10/15/2026' }, 'AMBIGUOUS_ACTION'],
    ['impossible date', { dueDate: '2026-02-31' }, 'AMBIGUOUS_ACTION'],
    ['non-current cycle', { cycleId: '2026-11' }, 'INVALID_CYCLE_TRANSITION'],
  ])('rejects %s without writing anything', async (_name, overrides, code) => {
    const before = counts();
    const result = await run('mason', electricity(overrides));
    expect(result).toMatchObject({ kind: 'rejected', code });
    expect(counts()).toEqual(before);
  });

  it('rejects a non-member actor and an unknown household', async () => {
    expect(await run('stranger', electricity())).toMatchObject({ kind: 'rejected', code: 'UNAUTHORIZED_ACTOR' });
    const result = await service.execute({
      commandId: 'c-x',
      actorId: 'mason',
      householdId: 'other-house',
      sourceEventId: 'e',
      payload: electricity(),
    });
    expect(result).toMatchObject({ kind: 'rejected', code: 'UNKNOWN_RESOURCE' });
    expect(counts().bills).toBe(0);
  });

  it('treats a replayed commandId as a duplicate that creates nothing new', async () => {
    expect(await run('mason', electricity(), 'cmd-fixed')).toEqual({ kind: 'accepted' });
    const before = counts();
    expect(await run('mason', electricity(), 'cmd-fixed')).toEqual({ kind: 'duplicate' });
    expect(counts()).toEqual(before);
    expect(counts().bills).toBe(1);
  });

  it('does not record a rejected command, so a corrected retry is judged afresh', async () => {
    expect(await run('mason', electricity({ amountCents: 0 }), 'cmd-retry')).toMatchObject({ kind: 'rejected' });
    expect(store.isCommandProcessed('cmd-retry')).toBe(false);
    expect(await run('mason', electricity(), 'cmd-retry')).toEqual({ kind: 'accepted' });
  });
});

describe('approve', () => {
  it("records the member's own approval and acts only on their proposal", async () => {
    const { proposalIds } = await addElectricity();
    expect(await run('mason', { kind: 'approve', proposalId: proposalIds.mason, proposalVersion: 1 })).toEqual({ kind: 'accepted' });

    expect(ledger.proposal(proposalIds.mason)!.status).toBe('confirmed');
    expect(ledger.proposal(proposalIds.alex)!.status).toBe('proposed');
    expect(ledger.proposal(proposalIds.jordan)!.status).toBe('proposed');
    expect(store.approvalsFor(proposalIds.mason, 1)).toEqual(['mason']);
  });

  it("rejects approval of someone else's proposal", async () => {
    const { proposalIds } = await addElectricity();
    const before = counts();
    const result = await run('alex', { kind: 'approve', proposalId: proposalIds.mason, proposalVersion: 1 });
    expect(result).toMatchObject({ kind: 'rejected', code: 'UNAUTHORIZED_ACTOR' });
    expect(counts()).toEqual(before);
    expect(ledger.proposal(proposalIds.mason)!.status).toBe('proposed');
  });

  it('rejects stale and future versions with the standard message', async () => {
    const { proposalIds } = await addElectricity();
    for (const proposalVersion of [0, 2]) {
      const result = await run('mason', { kind: 'approve', proposalId: proposalIds.mason, proposalVersion });
      expect(result).toEqual({
        kind: 'rejected',
        code: 'STALE_PROPOSAL',
        userMessage: 'That request has changed. Please approve the latest version.',
      });
    }
    expect(counts().approvals).toBe(0);
  });

  it('rejects an unknown proposal', async () => {
    await addElectricity();
    expect(await run('mason', { kind: 'approve', proposalId: 'nope', proposalVersion: 1 })).toMatchObject({
      kind: 'rejected',
      code: 'UNKNOWN_RESOURCE',
    });
  });

  it('treats a second approval by the same actor (new command ID) as a duplicate', async () => {
    const { proposalIds } = await addElectricity();
    await run('mason', { kind: 'approve', proposalId: proposalIds.mason, proposalVersion: 1 });
    const before = counts();
    expect(await run('mason', { kind: 'approve', proposalId: proposalIds.mason, proposalVersion: 1 })).toEqual({ kind: 'duplicate' });
    expect(counts().approvals).toBe(before.approvals);
    expect(counts().outbox).toBe(before.outbox);
  });

  it('refuses a proposal that is already in the bank pipeline', async () => {
    const { proposalIds } = await addElectricity();
    ledger.setProposalStatus(proposalIds.alex, 'submitted', NOW);
    const result = await run('alex', { kind: 'approve', proposalId: proposalIds.alex, proposalVersion: 1 });
    expect(result).toMatchObject({ kind: 'rejected', code: 'ALREADY_SUBMITTED' });
    expect(counts().approvals).toBe(0);
  });

  it('announces the approval to the group', async () => {
    const { proposalIds } = await addElectricity();
    await run('mason', { kind: 'approve', proposalId: proposalIds.mason, proposalVersion: 1 });
    const ack = store.pendingOutbox().find((m) => m.text === 'Mason approved $48.00 for Electricity.');
    expect(ack?.audience).toEqual({ kind: 'group', spaceId: 'space-1' });
  });
});

describe('decline', () => {
  it('declines privately and leaves a later approval of the same version impossible', async () => {
    const { proposalIds } = await addElectricity();
    expect(await run('jordan', { kind: 'decline', proposalId: proposalIds.jordan, proposalVersion: 1 })).toEqual({ kind: 'accepted' });
    expect(ledger.proposal(proposalIds.jordan)!.status).toBe('declined');

    const confirmation = store.pendingOutbox().at(-1)!;
    expect(confirmation.audience).toEqual({ kind: 'private', userId: 'jordan' });

    const result = await run('jordan', { kind: 'approve', proposalId: proposalIds.jordan, proposalVersion: 1 });
    expect(result).toMatchObject({ kind: 'rejected', code: 'STALE_PROPOSAL' });
    expect(bank.submitCalls).toHaveLength(0);
  });

  it('does not tell the group who declined', async () => {
    const { proposalIds } = await addElectricity();
    const groupBefore = store.pendingOutbox().filter((m) => m.audience.kind === 'group').length;
    await run('jordan', { kind: 'decline', proposalId: proposalIds.jordan, proposalVersion: 1 });
    const groupAfter = store.pendingOutbox().filter((m) => m.audience.kind === 'group').length;
    expect(groupAfter).toBe(groupBefore);
  });

  it("rejects declining someone else's proposal or a stale version", async () => {
    const { proposalIds } = await addElectricity();
    expect(await run('alex', { kind: 'decline', proposalId: proposalIds.jordan, proposalVersion: 1 })).toMatchObject({
      code: 'UNAUTHORIZED_ACTOR',
    });
    expect(await run('jordan', { kind: 'decline', proposalId: proposalIds.jordan, proposalVersion: 5 })).toMatchObject({
      code: 'STALE_PROPOSAL',
    });
    expect(ledger.proposal(proposalIds.jordan)!.status).toBe('proposed');
  });

  it('declining twice is a duplicate; a declined-after-submitted attempt is refused', async () => {
    const { proposalIds } = await addElectricity();
    await run('jordan', { kind: 'decline', proposalId: proposalIds.jordan, proposalVersion: 1 });
    expect(await run('jordan', { kind: 'decline', proposalId: proposalIds.jordan, proposalVersion: 1 })).toEqual({ kind: 'duplicate' });

    ledger.setProposalStatus(proposalIds.alex, 'pending', NOW);
    expect(await run('alex', { kind: 'decline', proposalId: proposalIds.alex, proposalVersion: 1 })).toMatchObject({
      code: 'ALREADY_SUBMITTED',
    });
  });
});

describe('correct_bill', () => {
  const correction = (billId: string, overrides: Record<string, unknown> = {}): CommandPayload =>
    ({
      kind: 'correct_bill',
      billId,
      amountCents: 15_000,
      title: 'Electricity',
      dueDate: '2026-10-20',
      recipientId: 'electric',
      ...overrides,
    }) as CommandPayload;

  it('re-splits, bumps every proposal version and invalidates old approvals', async () => {
    const { billId, proposalIds } = await addElectricity();
    // An approval whose transfer was never sent (for example the app stopped right after recording it).
    store.recordApproval(proposalIds.mason, 1, 'mason', NOW);
    ledger.setProposalStatus(proposalIds.mason, 'approved', NOW);

    expect(await run('alex', correction(billId))).toEqual({ kind: 'accepted' });

    expect(ledger.bill(billId)).toMatchObject({ amountCents: 15_000, dueDate: '2026-10-20' });
    expect(ledger.obligations(billId)).toEqual({ mason: 5_000, alex: 5_000, jordan: 5_000 });
    for (const id of Object.values(proposalIds)) {
      expect(ledger.proposal(id)).toMatchObject({ version: 2, status: 'proposed', amountCents: 5_000 });
    }

    // Mason's v1 approval no longer counts; only v2 can be approved.
    expect(await run('mason', { kind: 'approve', proposalId: proposalIds.mason, proposalVersion: 1 })).toMatchObject({
      code: 'STALE_PROPOSAL',
    });
    expect(await run('mason', { kind: 'approve', proposalId: proposalIds.mason, proposalVersion: 2 })).toEqual({ kind: 'accepted' });
    // Only the v2 approval counts, and exactly one transfer of the new amount is sent.
    expect(ledger.proposal(proposalIds.mason)!.status).toBe('confirmed');
    expect(store.approvalsFor(proposalIds.mason, 2)).toEqual(['mason']);
    expect(bank.submitCalls).toHaveLength(1);
    expect(bank.submitCalls[0].amountCents).toBe(5_000);
  });

  it('re-requests a member who had declined, at the new version', async () => {
    const { billId, proposalIds } = await addElectricity();
    await run('jordan', { kind: 'decline', proposalId: proposalIds.jordan, proposalVersion: 1 });
    await run('mason', correction(billId));
    expect(ledger.proposal(proposalIds.jordan)).toMatchObject({ version: 2, status: 'proposed' });
  });

  it('posts new version-bound requests; the old message still resolves only to v1', async () => {
    const { billId, proposalIds } = await addElectricity();
    const first = store.pendingOutbox().find((m) => m.proposalRef?.proposalId === proposalIds.alex)!;
    store.recordDelivery(first.deliveryId, 'prov-old');
    await run('mason', correction(billId));
    const updated = store.pendingOutbox().find((m) => m.proposalRef?.proposalId === proposalIds.alex)!;
    expect(updated.proposalRef?.proposalVersion).toBe(2);
    expect(updated.text).toContain('Updated request');
    expect(store.lookupProviderBinding('prov-old')).toEqual({ proposalId: proposalIds.alex, proposalVersion: 1 });
  });

  it('rejects an invalid correction and changes nothing', async () => {
    const { billId } = await addElectricity();
    const before = counts();
    expect(await run('mason', correction(billId, { amountCents: -5 }))).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(await run('mason', correction(billId, { recipientId: 'ghost' }))).toMatchObject({ code: 'UNKNOWN_RESOURCE' });
    expect(await run('mason', correction('no-bill'))).toMatchObject({ code: 'UNKNOWN_RESOURCE' });
    expect(counts()).toEqual(before);
    expect(ledger.bill(billId)!.amountCents).toBe(14_400);
  });

  it('refuses once any contribution is confirmed', async () => {
    const { billId, proposalIds } = await addElectricity();
    store.db
      .prepare(
        `INSERT INTO allocations (allocation_id, bill_id, payer_id, beneficiary_id, amount_cents, operation_id, kind, created_at)
         VALUES ('al-1', ?, 'mason', 'mason', 4800, 'op-1', 'own', ?)`,
      )
      .run(billId, NOW);
    const result = await run('mason', correction(billId));
    expect(result).toMatchObject({ kind: 'rejected', code: 'ALREADY_SUBMITTED' });
    expect(ledger.proposal(proposalIds.mason)!.version).toBe(1);
    expect(ledger.bill(billId)!.amountCents).toBe(14_400);
  });

  it.each(['submitted', 'pending', 'unknown'] as const)(
    'refuses while a bank operation is %s',
    async (status) => {
      const { billId, proposalIds } = await addElectricity();
      store.insertBankOperation(
        {
          operationId: 'op-live',
          householdId: 'demo-house',
          proposalId: proposalIds.alex,
          proposalVersion: 1,
          fromAccountId: 'acct-alex',
          toAccountId: 'acct-house',
          amountCents: 4_800,
          description: 'x',
        },
        NOW,
      );
      store.updateBankOperation('op-live', { status }, NOW);
      expect(await run('mason', correction(billId))).toMatchObject({ code: 'ALREADY_SUBMITTED' });
      expect(ledger.bill(billId)!.amountCents).toBe(14_400);
    },
  );

  it('cancels an operation that was never sent, then corrects the bill', async () => {
    const { billId, proposalIds } = await addElectricity();
    store.insertBankOperation(
      {
        operationId: 'op-unsent',
        householdId: 'demo-house',
        proposalId: proposalIds.alex,
        proposalVersion: 1,
        fromAccountId: 'acct-alex',
        toAccountId: 'acct-house',
        amountCents: 4_800,
        description: 'x',
      },
      NOW,
    );
    expect(await run('mason', correction(billId))).toEqual({ kind: 'accepted' });
    expect(store.getBankOperation('op-unsent')).toMatchObject({ status: 'failed' });
    expect(store.unresolvedBankOperations()).toEqual([]);
    expect(bank.submitCalls).toHaveLength(0);
  });

  it('allows a correction after a failed bank operation (no money moved)', async () => {
    const { billId, proposalIds } = await addElectricity();
    store.insertBankOperation(
      {
        operationId: 'op-dead',
        householdId: 'demo-house',
        proposalId: proposalIds.alex,
        proposalVersion: 1,
        fromAccountId: 'acct-alex',
        toAccountId: 'acct-house',
        amountCents: 4_800,
        description: 'x',
      },
      NOW,
    );
    store.updateBankOperation('op-dead', { status: 'failed', reason: 'rejected' }, NOW);
    expect(await run('mason', correction(billId))).toEqual({ kind: 'accepted' });
  });

  it('refuses a paid bill and an open coverage or payment proposal', async () => {
    const { billId } = await addElectricity();
    ledger.insertProposal(
      {
        proposalId: 'prop-cov',
        householdId: 'demo-house',
        billId,
        purpose: 'coverage',
        version: 1,
        status: 'proposed',
        amountCents: 9_600,
        sourceAccountId: 'acct-alex',
        destinationAccountId: 'acct-house',
        requiredActorIds: ['alex', 'jordan'],
        allocation: [],
        description: 'coverage',
      },
      NOW,
    );
    expect(await run('mason', correction(billId))).toMatchObject({ code: 'ALREADY_SUBMITTED' });
    ledger.setProposalStatus('prop-cov', 'declined', NOW);
    ledger.setBillStatus(billId, 'paid');
    expect(await run('mason', correction(billId))).toMatchObject({ code: 'ALREADY_SUBMITTED' });
  });
});

describe('get_summary', () => {
  it('replies privately to the requester only', async () => {
    await addElectricity();
    const before = store.pendingOutbox().length;
    expect(await run('alex', { kind: 'get_summary', cycleId: '2026-10' })).toEqual({ kind: 'accepted' });
    const reply = store.pendingOutbox().at(-1)!;
    expect(store.pendingOutbox()).toHaveLength(before + 1);
    expect(reply.audience).toEqual({ kind: 'private', userId: 'alex' });
    expect(reply.text).toContain('Electricity (2026-10): $144.00 due 2026-10-15');
    expect(reply.text).toContain('Alex: agreed $48.00, confirmed $0.00');
    expect(reply.text).toContain('simulated');
  });

  it("shows only the requester's own debts", async () => {
    const { billId } = await addElectricity();
    store.db
      .prepare(
        `INSERT INTO debts (debt_id, household_id, debtor_id, creditor_id, original_cents, remaining_cents, source_bill_id, created_at)
         VALUES ('debt-1', 'demo-house', 'jordan', 'alex', 4800, 4800, ?, ?)`,
      )
      .run(billId, NOW);

    await run('mason', { kind: 'get_summary', cycleId: '2026-10' });
    await run('jordan', { kind: 'get_summary', cycleId: '2026-10' });
    await run('alex', { kind: 'get_summary', cycleId: '2026-10' });
    const [masonReply, jordanReply, alexReply] = store.pendingOutbox().slice(-3);

    expect(masonReply.text).not.toContain('owe');
    expect(masonReply.text).not.toContain('4800');
    expect(jordanReply.text).toContain('You owe Alex $48.00');
    expect(alexReply.text).toContain('Jordan owes you $48.00');
  });

  it('handles a cycle with no bills', async () => {
    await run('mason', { kind: 'get_summary', cycleId: '2026-10' });
    expect(store.pendingOutbox().at(-1)!.text).toContain('No bills yet for 2026-10.');
  });

  it('is deduplicated by command ID', async () => {
    await run('mason', { kind: 'get_summary', cycleId: '2026-10' }, 'cmd-sum');
    const n = store.pendingOutbox().length;
    expect(await run('mason', { kind: 'get_summary', cycleId: '2026-10' }, 'cmd-sum')).toEqual({ kind: 'duplicate' });
    expect(store.pendingOutbox()).toHaveLength(n);
  });
});
