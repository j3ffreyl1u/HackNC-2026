import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command, CommandPayload, ExecuteResult, HouseholdConfig } from '../../src/contracts/index.js';
import { UnknownActorError, createFinanceService, type FinanceService } from '../../src/finance/index.js';
import { Ledger } from '../../src/finance/ledger.js';
import { MockBank } from '../../src/finance/mock-bank.js';
import { MAX_REMINDERS_PER_BILL } from '../../src/finance/reminders.js';
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
  demoCycles: [
    { cycleId: '2026-10', bills: [] },
    { cycleId: '2026-11', bills: [{ title: 'Electricity', amountCents: 15_000, dueDate: '2026-11-15', recipientId: 'electric' }] },
  ],
};

const balances = { 'acct-mason': 100_000, 'acct-alex': 100_000, 'acct-jordan': 100_000, 'acct-house': 0, 'acct-electric': 0 };
const HOUR = 60 * 60 * 1000;

let store: LedgerStore;
let bank: MockBank;
let ledger: Ledger;
let service: FinanceService;
let nowMs: number;
let idCounter = 0;
let cmdCounter = 0;

beforeEach(async () => {
  idCounter = 0;
  cmdCounter = 0;
  nowMs = Date.parse('2026-10-10T12:00:00.000Z');
  store = LedgerStore.open(':memory:');
  bank = new MockBank({ balances });
  ledger = new Ledger(store);
  service = createFinanceService({ store, bank, clock: { now: () => new Date(nowMs) }, newId: (prefix) => `${prefix}-${++idCounter}` });
  await service.bootstrapHousehold(config);
});
afterEach(() => store.close());

function run(actorId: string, payload: CommandPayload, commandId = `cmd-${++cmdCounter}`): Promise<ExecuteResult> {
  const command: Command = { commandId, actorId, householdId: 'demo-house', sourceEventId: `evt-${commandId}`, payload };
  return service.execute(command);
}
const approve = (actor: string, proposalId: string, version = 1) => run(actor, { kind: 'approve', proposalId, proposalVersion: version });

const ownProposals = (billId: string) =>
  Object.fromEntries(ledger.proposalsForBill(billId).filter((p) => p.purpose === 'contribution').map((p) => [p.requiredActorIds[0], p]));
const paymentProposal = (billId: string) => ledger.proposalsForBill(billId).find((p) => p.purpose === 'bill_payment')!;

async function addElectricity(dueDate = '2026-10-15') {
  await run('mason', { kind: 'add_bill', amountCents: 14_400, title: 'Electricity', dueDate, recipientId: 'electric', cycleId: '2026-10' });
  const bill = ledger.billsForCycle('demo-house', '2026-10')[0];
  return { billId: bill.billId, own: ownProposals(bill.billId) };
}

async function coverJordan(billId: string) {
  await run('jordan', { kind: 'request_coverage', billId });
  const requestId = (store.db.prepare('SELECT request_id FROM coverage_requests').get() as { request_id: string }).request_id;
  await run('jordan', { kind: 'share_coverage_request', requestId, consent: true });
  await run('alex', { kind: 'offer_coverage', requestId, amountCents: 4_800 });
  return { requestId, coverage: ledger.proposalsForBill(billId).find((p) => p.purpose === 'coverage')! };
}

describe('getSnapshot', () => {
  it('matches the contract shape for a fresh bill', async () => {
    const { billId } = await addElectricity();
    const snapshot = await service.getSnapshot('demo-house');
    expect(snapshot).toEqual({
      householdId: 'demo-house',
      cycleId: '2026-10',
      currency: 'USD',
      balanceCents: 0,
      bills: [{ billId, title: 'Electricity', amountCents: 14_400, dueDate: '2026-10-15', status: 'collecting' }],
      contributions: [
        { billId, userId: 'mason', agreedCents: 4_800, confirmedCents: 0 },
        { billId, userId: 'alex', agreedCents: 4_800, confirmedCents: 0 },
        { billId, userId: 'jordan', agreedCents: 4_800, confirmedCents: 0 },
      ],
      debts: [],
      activity: [],
    });
  });

  it('reports the canonical October result: Mason 4,800, Alex 9,600, Jordan 0, and a 4,800 debt', async () => {
    const { billId, own } = await addElectricity();
    await approve('mason', own.mason.proposalId);
    const { coverage } = await coverJordan(billId);
    await approve('alex', coverage.proposalId);
    await approve('jordan', coverage.proposalId);

    const snapshot = await service.getSnapshot('demo-house');
    expect(snapshot.balanceCents).toBe(14_400);
    expect(snapshot.bills[0].status).toBe('ready');

    const paidBy = (userId: string) =>
      snapshot.contributions.filter((c) => c.userId === userId).reduce((sum, c) => sum + c.confirmedCents, 0);
    expect([paidBy('mason'), paidBy('alex'), paidBy('jordan')]).toEqual([4_800, 9_600, 0]);
    expect(snapshot.contributions).toContainEqual({ billId, userId: 'alex', agreedCents: 0, confirmedCents: 4_800, coveredForUserId: 'jordan' });
    expect(snapshot.contributions).toContainEqual({ billId, userId: 'jordan', agreedCents: 4_800, confirmedCents: 0 });
    expect(snapshot.debts).toEqual([
      { debtId: expect.any(String), debtorId: 'jordan', creditorId: 'alex', originalCents: 4_800, remainingCents: 4_800 },
    ]);
    expect(snapshot.activity.map((a) => a.status)).toEqual(['confirmed', 'confirmed']);
    expect(snapshot.activity[0].description).toBe("Alex covers Jordan's $48.00 share of Electricity");

    await approve('mason', paymentProposal(billId).proposalId);
    const after = await service.getSnapshot('demo-house');
    expect(after.balanceCents).toBe(0);
    expect(after.bills[0].status).toBe('paid');
    expect(after.activity[0]).toMatchObject({ status: 'confirmed' });
  });

  it('maps in-flight and failed operations to pending, unknown and failed', async () => {
    const { own } = await addElectricity();
    bank.inject('pending');
    await approve('mason', own.mason.proposalId);
    bank.setSupportsFindTransfer(false);
    bank.inject('throw-after');
    await approve('alex', own.alex.proposalId);
    bank.inject('fail');
    await approve('jordan', own.jordan.proposalId);

    const snapshot = await service.getSnapshot('demo-house');
    expect(snapshot.activity.map((a) => a.status)).toEqual(['failed', 'unknown', 'pending']);
    expect(snapshot.balanceCents).toBe(0); // only confirmed money counts
  });

  it('shows the November credit preview with the debt still owed, then cleared once paid', async () => {
    const { billId, own } = await addElectricity();
    await approve('mason', own.mason.proposalId);
    const { coverage } = await coverJordan(billId);
    await approve('alex', coverage.proposalId);
    await approve('jordan', coverage.proposalId);
    await approve('mason', paymentProposal(billId).proposalId);

    await service.advanceDemoCycle('demo-house', '2026-11');
    let snapshot = await service.getSnapshot('demo-house');
    expect(snapshot.cycleId).toBe('2026-11');
    expect(snapshot.debts[0].remainingCents).toBe(4_800);

    const november = ledger.billsForCycle('demo-house', '2026-11')[0];
    const nov = ownProposals(november.billId);
    await approve('mason', nov.mason.proposalId);
    await approve('alex', nov.alex.proposalId);
    await approve('jordan', nov.jordan.proposalId);
    snapshot = await service.getSnapshot('demo-house');
    expect(snapshot.debts[0].remainingCents).toBe(0);
    expect(snapshot.debts[0].originalCents).toBe(4_800);
  });

  it('contains no bank accounts, provider identities, private requests or failure reasons', async () => {
    const { billId, own } = await addElectricity();
    bank.setBalance('acct-jordan', 1_000);
    await approve('jordan', own.jordan.proposalId); // fails: insufficient funds
    await run('jordan', { kind: 'request_coverage', billId }); // private, awaiting consent
    await approve('mason', own.mason.proposalId);

    const json = JSON.stringify(await service.getSnapshot('demo-house'));
    for (const secret of ['acct-', 'p-mason', 'p-alex', 'p-jordan', 'space-1', 'insufficient', 'cov-', 'Nothing is shared', 'consent']) {
      expect(json).not.toContain(secret);
    }
  });

  it('a private coverage question does not change the public snapshot at all', async () => {
    const { billId } = await addElectricity();
    const before = await service.getSnapshot('demo-house');
    await run('jordan', { kind: 'request_coverage', billId });
    expect(await service.getSnapshot('demo-house')).toEqual(before);
  });

  it('rejects an unknown household', async () => {
    await expect(service.getSnapshot('nobody')).rejects.toThrow();
  });
});

describe('getConversationContext', () => {
  it("lists only proposals the actor may act on, in the group and in private", async () => {
    const { own } = await addElectricity();
    for (const space of ['space-1', 'dm-mason']) {
      const ctx = await service.getConversationContext('mason', space);
      expect(ctx.householdId).toBe('demo-house');
      expect(ctx.cycleId).toBe('2026-10');
      expect(ctx.actionableProposals).toEqual([
        { proposalId: own.mason.proposalId, proposalVersion: 1, description: 'Mason contributes $48.00 to the household account for Electricity ($48.00)' },
      ]);
      expect(ctx.openBills).toEqual([{ billId: expect.any(String), title: 'Electricity' }]);
    }
  });

  it('after approving, nothing is left to act on', async () => {
    const { own } = await addElectricity();
    await approve('mason', own.mason.proposalId);
    expect((await service.getConversationContext('mason', 'space-1')).actionableProposals).toEqual([]);
    expect((await service.getConversationContext('alex', 'space-1')).actionableProposals).toHaveLength(1);
  });

  it('lists every candidate so the conversation layer can ask which one', async () => {
    await addElectricity();
    await run('mason', { kind: 'add_bill', amountCents: 9_000, title: 'Internet', dueDate: '2026-10-16', recipientId: 'electric', cycleId: '2026-10' });
    const ctx = await service.getConversationContext('mason', 'space-1');
    expect(ctx.actionableProposals).toHaveLength(2);
    expect(ctx.openBills.map((b) => b.title)).toEqual(['Electricity', 'Internet']);
  });

  it('exposes the private consent question only in a private space', async () => {
    const { billId } = await addElectricity();
    await run('jordan', { kind: 'request_coverage', billId });
    const requestId = (store.db.prepare('SELECT request_id FROM coverage_requests').get() as { request_id: string }).request_id;

    expect((await service.getConversationContext('jordan', 'dm-jordan')).privateCoverageRequestId).toBe(requestId);
    expect((await service.getConversationContext('jordan', 'space-1')).privateCoverageRequestId).toBeUndefined();
    expect((await service.getConversationContext('alex', 'dm-alex')).privateCoverageRequestId).toBeUndefined();
    expect((await service.getConversationContext('mason', 'dm-mason')).privateCoverageRequestId).toBeUndefined();

    await run('jordan', { kind: 'share_coverage_request', requestId, consent: true });
    expect((await service.getConversationContext('jordan', 'dm-jordan')).privateCoverageRequestId).toBeUndefined();
  });

  it("never carries another member's private history", async () => {
    const { billId } = await addElectricity();
    await run('jordan', { kind: 'request_coverage', billId });
    const json = JSON.stringify([
      await service.getConversationContext('mason', 'space-1'),
      await service.getConversationContext('alex', 'dm-alex'),
    ]);
    expect(json).not.toContain('cov-');
    expect(json).not.toContain('coverage');
    expect(json).not.toContain('acct-');
  });

  it('coverage agreements are actionable for exactly the two parties until each approves', async () => {
    const { billId } = await addElectricity();
    const { coverage } = await coverJordan(billId);
    const ids = async (user: string) => (await service.getConversationContext(user, 'space-1')).actionableProposals.map((p) => p.proposalId);
    expect(await ids('alex')).toContain(coverage.proposalId);
    expect(await ids('jordan')).toContain(coverage.proposalId);
    expect(await ids('mason')).not.toContain(coverage.proposalId);

    await approve('alex', coverage.proposalId);
    expect(await ids('alex')).not.toContain(coverage.proposalId);
    expect(await ids('jordan')).toContain(coverage.proposalId);
  });

  it('declined and superseded proposals are not actionable', async () => {
    const { billId, own } = await addElectricity();
    await run('mason', { kind: 'decline', proposalId: own.mason.proposalId, proposalVersion: 1 });
    expect((await service.getConversationContext('mason', 'space-1')).actionableProposals).toEqual([]);
    await coverJordan(billId);
    const jordan = await service.getConversationContext('jordan', 'space-1');
    expect(jordan.actionableProposals.map((p) => p.proposalId)).not.toContain(own.jordan.proposalId);
  });

  describe('target message resolution', () => {
    async function deliveredRequests() {
      const { billId, own } = await addElectricity();
      for (const message of await service.pendingMessages()) {
        if (message.proposalRef) await service.recordDelivery(message.deliveryId, `prov-${message.proposalRef.proposalId}-v${message.proposalRef.proposalVersion}`);
      }
      return { billId, own };
    }

    it('resolves a reaction target by the exact provider message', async () => {
      const { own } = await deliveredRequests();
      const ctx = await service.getConversationContext('mason', 'space-1', `prov-${own.mason.proposalId}-v1`);
      expect(ctx.targetProposal).toEqual({ proposalId: own.mason.proposalId, proposalVersion: 1 });
    });

    it('an unknown message resolves to nothing', async () => {
      await deliveredRequests();
      expect((await service.getConversationContext('mason', 'space-1', 'prov-unknown')).targetProposal).toBeUndefined();
      expect((await service.getConversationContext('mason', 'space-1')).targetProposal).toBeUndefined();
    });

    it("a reaction to someone else's request resolves, but approving it is refused and sends no money", async () => {
      const { own } = await deliveredRequests();
      const ctx = await service.getConversationContext('alex', 'space-1', `prov-${own.mason.proposalId}-v1`);
      expect(ctx.targetProposal).toEqual({ proposalId: own.mason.proposalId, proposalVersion: 1 });
      expect(await approve('alex', ctx.targetProposal!.proposalId, ctx.targetProposal!.proposalVersion)).toMatchObject({
        kind: 'rejected',
        code: 'UNAUTHORIZED_ACTOR',
      });
      expect(bank.submitCalls).toHaveLength(0);
    });

    it('a reaction to an out-of-date message resolves to its old version and is refused as stale', async () => {
      const { billId, own } = await deliveredRequests();
      await run('mason', { kind: 'correct_bill', billId, amountCents: 15_000, title: 'Electricity', dueDate: '2026-10-15', recipientId: 'electric' });
      const ctx = await service.getConversationContext('mason', 'space-1', `prov-${own.mason.proposalId}-v1`);
      expect(ctx.targetProposal).toEqual({ proposalId: own.mason.proposalId, proposalVersion: 1 });
      expect(await approve('mason', ctx.targetProposal!.proposalId, ctx.targetProposal!.proposalVersion)).toMatchObject({
        code: 'STALE_PROPOSAL',
      });
      expect(bank.submitCalls).toHaveLength(0);
    });
  });

  it('rejects an actor who is not enrolled', async () => {
    await expect(service.getConversationContext('stranger', 'space-1')).rejects.toBeInstanceOf(UnknownActorError);
  });

  it('openBills drops a bill once it is paid', async () => {
    const { billId, own } = await addElectricity();
    for (const user of ['mason', 'alex', 'jordan']) await approve(user, own[user].proposalId);
    expect((await service.getConversationContext('mason', 'space-1')).openBills).toHaveLength(1);
    await approve('mason', paymentProposal(billId).proposalId);
    expect((await service.getConversationContext('mason', 'space-1')).openBills).toEqual([]);
  });
});

describe('processReminders', () => {
  const privateReminders = () =>
    store.pendingOutbox().filter((m) => m.deliveryId.startsWith('deliv:reminder:'));

  it('sends nothing until the bill is within 48 hours of its due date', async () => {
    await addElectricity('2026-10-15');
    nowMs = Date.parse('2026-10-12T23:59:00Z'); // 48h and 1 minute before the 15th
    await service.processReminders('demo-house');
    expect(privateReminders()).toEqual([]);

    nowMs = Date.parse('2026-10-13T00:00:00Z');
    await service.processReminders('demo-house');
    expect(privateReminders()).toHaveLength(3);
  });

  it('reminds only members with an unpaid request, privately, bound to their proposal', async () => {
    const { own } = await addElectricity();
    await approve('mason', own.mason.proposalId);
    nowMs = Date.parse('2026-10-14T00:00:00Z');
    await service.processReminders('demo-house');

    const reminders = privateReminders();
    expect(reminders.map((m) => (m.audience.kind === 'private' ? m.audience.userId : 'group')).sort()).toEqual(['alex', 'jordan']);
    for (const m of reminders) {
      expect(m.audience.kind).toBe('private');
      expect(m.text).toContain('$48.00');
      expect(m.text).toContain('Electricity');
      expect(m.proposalRef?.proposalVersion).toBe(1);
      expect(m.text).toContain(`approve ${m.proposalRef!.proposalId} v1`);
    }
    expect(store.pendingOutbox().filter((m) => m.audience.kind === 'group' && m.deliveryId.includes('reminder'))).toEqual([]);
  });

  it('at most one reminder per member per bill in 24 hours, and a hard cap after that', async () => {
    await addElectricity();
    nowMs = Date.parse('2026-10-14T00:00:00Z');
    await service.processReminders('demo-house');
    expect(privateReminders()).toHaveLength(3);

    await service.processReminders('demo-house');
    nowMs += 23 * HOUR;
    await service.processReminders('demo-house');
    expect(privateReminders()).toHaveLength(3);

    nowMs += 1 * HOUR;
    await service.processReminders('demo-house');
    expect(privateReminders()).toHaveLength(6);

    nowMs += 24 * HOUR;
    await service.processReminders('demo-house');
    expect(privateReminders()).toHaveLength(9);

    nowMs += 24 * HOUR;
    await service.processReminders('demo-house');
    expect(privateReminders()).toHaveLength(3 * MAX_REMINDERS_PER_BILL);
  });

  it('keeps reminding after the due date while the share is unpaid', async () => {
    await addElectricity('2026-10-15');
    nowMs = Date.parse('2026-10-20T00:00:00Z');
    await service.processReminders('demo-house');
    expect(privateReminders()).toHaveLength(3);
  });

  it('stops for a member as soon as their payment is confirmed', async () => {
    const { own } = await addElectricity();
    nowMs = Date.parse('2026-10-14T00:00:00Z');
    await service.processReminders('demo-house');
    await approve('alex', own.alex.proposalId);
    nowMs += 25 * HOUR;
    await service.processReminders('demo-house');
    const second = privateReminders().filter((m) => m.deliveryId.endsWith(':2'));
    expect(second.map((m) => (m.audience.kind === 'private' ? m.audience.userId : '')).sort()).toEqual(['jordan', 'mason']);
  });

  it('is silent for payments that are pending or whose outcome is unknown', async () => {
    const { own } = await addElectricity();
    bank.inject('pending');
    await approve('mason', own.mason.proposalId);
    bank.setSupportsFindTransfer(false);
    bank.inject('throw-after');
    await approve('alex', own.alex.proposalId);
    nowMs = Date.parse('2026-10-14T00:00:00Z');
    await service.processReminders('demo-house');
    expect(privateReminders().map((m) => (m.audience.kind === 'private' ? m.audience.userId : ''))).toEqual(['jordan']);
  });

  it('suppresses the debtor and volunteer while a coverage agreement awaits approval', async () => {
    const { billId } = await addElectricity();
    await coverJordan(billId);
    nowMs = Date.parse('2026-10-14T00:00:00Z');
    await service.processReminders('demo-house');
    expect(privateReminders().map((m) => (m.audience.kind === 'private' ? m.audience.userId : ''))).toEqual(['mason']);
  });

  it('resumes for the debtor if the agreement falls through', async () => {
    const { billId } = await addElectricity();
    const { coverage } = await coverJordan(billId);
    await run('jordan', { kind: 'decline', proposalId: coverage.proposalId, proposalVersion: 1 });
    nowMs = Date.parse('2026-10-14T00:00:00Z');
    await service.processReminders('demo-house');
    const users = privateReminders().map((m) => (m.audience.kind === 'private' ? m.audience.userId : '')).sort();
    expect(users).toEqual(['alex', 'jordan', 'mason']);
  });

  it('does nothing for a funded, paid or unknown household', async () => {
    const { billId, own } = await addElectricity();
    for (const user of ['mason', 'alex', 'jordan']) await approve(user, own[user].proposalId);
    nowMs = Date.parse('2026-10-14T00:00:00Z');
    await service.processReminders('demo-house');
    await approve('mason', paymentProposal(billId).proposalId);
    await service.processReminders('demo-house');
    await service.processReminders('nobody');
    expect(privateReminders()).toEqual([]);
  });

  it('states the actual request amount when carried-over credit changes it', async () => {
    const { billId, own } = await addElectricity();
    await approve('mason', own.mason.proposalId);
    const { coverage } = await coverJordan(billId);
    await approve('alex', coverage.proposalId);
    await approve('jordan', coverage.proposalId);
    await approve('mason', paymentProposal(billId).proposalId);
    await service.advanceDemoCycle('demo-house', '2026-11');

    nowMs = Date.parse('2026-11-14T00:00:00Z');
    await service.processReminders('demo-house');
    const texts = privateReminders().filter((m) => m.deliveryId.includes(':1') && m.text.includes('$')).map((m) => m.text);
    expect(texts.some((t) => t.includes('$98.00'))).toBe(true);
    expect(texts.some((t) => t.includes('$2.00'))).toBe(true);
    expect(texts.some((t) => t.includes('$50.00'))).toBe(true);
  });
});

describe('the monthly statement', () => {
  it('explains the closed bill, the new bill and the prior credit in the group', async () => {
    const { billId, own } = await addElectricity();
    await approve('mason', own.mason.proposalId);
    const { coverage } = await coverJordan(billId);
    await approve('alex', coverage.proposalId);
    await approve('jordan', coverage.proposalId);
    await approve('mason', paymentProposal(billId).proposalId);
    await service.advanceDemoCycle('demo-house', '2026-11');

    const statement = store.pendingOutbox().find((m) => m.deliveryId === 'deliv:statement:demo-house:2026-11')!;
    expect(statement.audience).toEqual({ kind: 'group', spaceId: 'space-1' });
    expect(statement.text).toContain('2026-11 statement');
    expect(statement.text).toContain('Closed 2026-10: Electricity $144.00 paid');
    expect(statement.text).toContain('Due now: Electricity $150.00 by 2026-11-15');
    expect(statement.text).toContain('Prior credit: Jordan owes Alex $48.00');
    expect(statement.text).toContain('cleared only once both payments are confirmed');

    await service.advanceDemoCycle('demo-house', '2026-11');
    expect(store.pendingOutbox().filter((m) => m.deliveryId.startsWith('deliv:statement:'))).toHaveLength(1);
  });

  it('without any debt the statement mentions no credit', async () => {
    await service.advanceDemoCycle('demo-house', '2026-11');
    const statement = store.pendingOutbox().find((m) => m.deliveryId.startsWith('deliv:statement:'))!;
    expect(statement.text).not.toContain('Prior credit');
    expect(statement.text).toContain('Due now: Electricity $150.00');
  });

  it('shows open requests in the private summary', async () => {
    const { own } = await addElectricity();
    await run('alex', { kind: 'get_summary', cycleId: '2026-10' });
    const summary = store.pendingOutbox().filter((m) => m.audience.kind === 'private' && m.audience.userId === 'alex').at(-1)!;
    expect(summary.text).toContain(`Approve with "approve ${own.alex.proposalId} v1"`);
  });
});
