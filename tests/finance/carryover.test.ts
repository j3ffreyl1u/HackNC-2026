import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command, CommandPayload, ExecuteResult, HouseholdConfig } from '../../src/contracts/index.js';
import { CycleTransitionError, createFinanceService, type FinanceService } from '../../src/finance/index.js';
import { Ledger } from '../../src/finance/ledger.js';
import { MockBank } from '../../src/finance/mock-bank.js';
import { LedgerStore } from '../../src/finance/store.js';

type CycleBills = HouseholdConfig['demoCycles'][number]['bills'];

const electricNovember: CycleBills = [{ title: 'Electricity', amountCents: 15_000, dueDate: '2026-11-15', recipientId: 'electric' }];

function houseConfig(novemberBills: CycleBills = electricNovember): HouseholdConfig {
  return {
    householdId: 'demo-house',
    groupSpaceId: 'space-1',
    designatedPayerId: 'mason',
    householdAccountId: 'acct-house',
    members: [
      { userId: 'mason', displayName: 'Mason', providerUserId: 'p-mason', bankAccountId: 'acct-mason' },
      { userId: 'alex', displayName: 'Alex', providerUserId: 'p-alex', bankAccountId: 'acct-alex' },
      { userId: 'jordan', displayName: 'Jordan', providerUserId: 'p-jordan', bankAccountId: 'acct-jordan' },
    ],
    recipients: [
      { recipientId: 'electric', displayName: 'Power Co', bankAccountId: 'acct-electric' },
      { recipientId: 'internet', displayName: 'Net Co', bankAccountId: 'acct-internet' },
    ],
    demoCycles: [
      { cycleId: '2026-10', bills: [] },
      { cycleId: '2026-11', bills: novemberBills },
    ],
  };
}

const NOW = '2026-10-10T12:00:00.000Z';
const balances = { 'acct-mason': 100_000, 'acct-alex': 100_000, 'acct-jordan': 100_000, 'acct-house': 0, 'acct-electric': 0, 'acct-internet': 0 };

let store: LedgerStore;
let bank: MockBank;
let ledger: Ledger;
let service: FinanceService;
let idCounter = 0;
let cmdCounter = 0;

async function boot(novemberBills?: CycleBills) {
  idCounter = 0;
  cmdCounter = 0;
  store = LedgerStore.open(':memory:');
  bank = new MockBank({ balances });
  ledger = new Ledger(store);
  service = createFinanceService({ store, bank, clock: { now: () => new Date(NOW) }, newId: (prefix) => `${prefix}-${++idCounter}` });
  await service.bootstrapHousehold(houseConfig(novemberBills));
}

beforeEach(() => boot());
afterEach(() => store.close());

function run(actorId: string, payload: CommandPayload, commandId = `cmd-${++cmdCounter}`): Promise<ExecuteResult> {
  const command: Command = { commandId, actorId, householdId: 'demo-house', sourceEventId: `evt-${commandId}`, payload };
  return service.execute(command);
}
const approve = (actor: string, proposalId: string, version = 1) => run(actor, { kind: 'approve', proposalId, proposalVersion: version });

const ownProposals = (billId: string) =>
  Object.fromEntries(ledger.proposalsForBill(billId).filter((p) => p.purpose === 'contribution').map((p) => [p.requiredActorIds[0], p]));
const paymentProposal = (billId: string) => ledger.proposalsForBill(billId).find((p) => p.purpose === 'bill_payment')!;
const debtRows = () => store.db.prepare('SELECT * FROM debts').all() as Array<{ debt_id: string; debtor_id: string; creditor_id: string; remaining_cents: number }>;
const settlementRows = () =>
  store.db.prepare('SELECT * FROM settlements').all() as Array<{ settlement_id: string; debt_id: string; amount_cents: number; status: string; applications_json: string }>;
const groupTexts = () => store.pendingOutbox().filter((m) => m.audience.kind === 'group').map((m) => m.text);
const billCount = () => (store.db.prepare('SELECT COUNT(*) AS n FROM bills').get() as { n: number }).n;

/** October, exactly as in the acceptance story: Alex covers Jordan, Mason pays the electric company. */
async function runOctober() {
  await run('mason', { kind: 'add_bill', amountCents: 14_400, title: 'Electricity', dueDate: '2026-10-15', recipientId: 'electric', cycleId: '2026-10' });
  const bill = ledger.billsForCycle('demo-house', '2026-10')[0];
  const own = ownProposals(bill.billId);
  await approve('mason', own.mason.proposalId);
  await run('jordan', { kind: 'request_coverage', billId: bill.billId });
  const requestId = (store.db.prepare('SELECT request_id FROM coverage_requests').get() as { request_id: string }).request_id;
  await run('jordan', { kind: 'share_coverage_request', requestId, consent: true });
  await run('alex', { kind: 'offer_coverage', requestId, amountCents: 4_800 });
  const coverage = ledger.proposalsForBill(bill.billId).find((p) => p.purpose === 'coverage')!;
  await approve('alex', coverage.proposalId);
  await approve('jordan', coverage.proposalId);
  await approve('mason', paymentProposal(bill.billId).proposalId);
  expect(ledger.bill(bill.billId)!.status).toBe('paid');
  return bill.billId;
}

describe('the canonical two-cycle story', () => {
  it('October leaves Jordan owing Alex 4,800 and a paid 14,400 bill', async () => {
    const october = await runOctober();
    expect(ledger.bill(october)!.status).toBe('paid');
    expect(await bank.getBalance('acct-electric')).toBe(14_400);
    expect(debtRows()).toEqual([expect.objectContaining({ debtor_id: 'jordan', creditor_id: 'alex', remaining_cents: 4_800 })]);
    expect(await bank.getBalance('acct-mason')).toBe(95_200);
    expect(await bank.getBalance('acct-alex')).toBe(90_400);
    expect(await bank.getBalance('acct-jordan')).toBe(100_000);
  });

  it('November previews 5,000 / 200 / 9,800 and the debt is still owed', async () => {
    await runOctober();
    await service.advanceDemoCycle('demo-house', '2026-11');

    expect(ledger.currentCycle('demo-house')).toBe('2026-11');
    const [bill] = ledger.billsForCycle('demo-house', '2026-11');
    expect(bill).toMatchObject({ title: 'Electricity', amountCents: 15_000, dueDate: '2026-11-15', status: 'collecting' });
    expect(ledger.obligations(bill.billId)).toEqual({ mason: 5_000, alex: 5_000, jordan: 5_000 });

    const own = ownProposals(bill.billId);
    expect([own.mason.amountCents, own.alex.amountCents, own.jordan.amountCents]).toEqual([5_000, 200, 9_800]);
    expect(own.mason.amountCents + own.alex.amountCents + own.jordan.amountCents).toBe(15_000);
    expect(own.jordan.allocation).toEqual([
      { payerId: 'jordan', beneficiaryId: 'jordan', amountCents: 5_000, kind: 'own' },
      { payerId: 'jordan', beneficiaryId: 'alex', amountCents: 4_800, kind: 'credit_settlement' },
    ]);
    expect(own.alex.allocation).toEqual([{ payerId: 'alex', beneficiaryId: 'alex', amountCents: 200, kind: 'own' }]);
    expect(own.mason.sourceAccountId).toBe('acct-mason');

    // Displaying the requests clears nothing: the debt is intact and the credit is only reserved.
    expect(debtRows()[0].remaining_cents).toBe(4_800);
    expect(settlementRows()).toEqual([expect.objectContaining({ amount_cents: 4_800, status: 'pending' })]);
    expect(JSON.parse(settlementRows()[0].applications_json)).toEqual([{ billId: bill.billId, amountCents: 4_800 }]);
  });

  it('explains the credit in the group statement for each affected member', async () => {
    await runOctober();
    await service.advanceDemoCycle('demo-house', '2026-11');
    const texts = groupTexts().filter((t) => t.includes('Electricity: $150.00'));
    const jordan = texts.find((t) => t.includes("Jordan's request"))!;
    const alex = texts.find((t) => t.includes("Alex's request"))!;
    const mason = texts.find((t) => t.includes("Mason's share"))!;
    expect(jordan).toContain('$98.00');
    expect(jordan).toContain('$48.00 repaying Alex');
    expect(alex).toContain('$2.00');
    expect(alex).toContain("Jordan's $48.00 repayment covers the rest of their share");
    expect(alex).toContain('stays open until both payments are confirmed');
    expect(mason).toContain('$50.00');
    expect(mason).not.toContain('repay');
  });

  it('clears the debt exactly once, after both affected contributions are confirmed, then pays 15,000', async () => {
    await runOctober();
    await service.advanceDemoCycle('demo-house', '2026-11');
    const [bill] = ledger.billsForCycle('demo-house', '2026-11');
    const own = ownProposals(bill.billId);

    await approve('mason', own.mason.proposalId);
    expect(debtRows()[0].remaining_cents).toBe(4_800);

    await approve('jordan', own.jordan.proposalId);
    // Jordan's repayment is confirmed, but Alex's side is not: the settlement stays pending.
    expect(debtRows()[0].remaining_cents).toBe(4_800);
    expect(settlementRows()[0].status).toBe('pending');

    await approve('alex', own.alex.proposalId);
    expect(debtRows()[0].remaining_cents).toBe(0);
    expect(settlementRows()).toEqual([expect.objectContaining({ status: 'applied', amount_cents: 4_800 })]);
    expect(groupTexts().filter((t) => t.includes('earlier coverage debt is cleared'))).toHaveLength(1);

    // Bill funded: 5,000 + 9,800 + 200 = 15,000, and the outgoing payment awaits Mason.
    expect(ledger.bill(bill.billId)!.status).toBe('ready');
    expect(ledger.confirmedTotal(bill.billId)).toBe(15_000);
    expect(ledger.confirmedByBeneficiary(bill.billId)).toEqual({ mason: 5_000, alex: 5_000, jordan: 5_000 });
    expect(paymentProposal(bill.billId)).toMatchObject({ amountCents: 15_000, requiredActorIds: ['mason'] });

    await approve('mason', paymentProposal(bill.billId).proposalId);
    expect(ledger.bill(bill.billId)!.status).toBe('paid');
    expect(await bank.getBalance('acct-electric')).toBe(29_400);
    expect(await bank.getBalance('acct-house')).toBe(0);
    expect(await bank.getBalance('acct-jordan')).toBe(90_200); // 100,000 - 9,800
    expect(await bank.getBalance('acct-alex')).toBe(90_200); // 100,000 - 9,600 - 200
    expect(await bank.getBalance('acct-mason')).toBe(90_200); // 100,000 - 4,800 - 5,000

    // Nothing later can clear it again.
    await service.reconcile('demo-house');
    await service.reconcile('demo-house');
    expect(debtRows()[0].remaining_cents).toBe(0);
    expect(settlementRows()).toHaveLength(1);
  });

  it('clears the same way when Alex pays before Jordan', async () => {
    await runOctober();
    await service.advanceDemoCycle('demo-house', '2026-11');
    const own = ownProposals(ledger.billsForCycle('demo-house', '2026-11')[0].billId);
    await approve('alex', own.alex.proposalId);
    expect(debtRows()[0].remaining_cents).toBe(4_800);
    await approve('jordan', own.jordan.proposalId);
    expect(debtRows()[0].remaining_cents).toBe(0);
    expect(settlementRows()[0].status).toBe('applied');
  });
});

describe('advancing the cycle', () => {
  it('advancing twice changes nothing the second time', async () => {
    await runOctober();
    await service.advanceDemoCycle('demo-house', '2026-11');
    const proposals = (store.db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n;
    const outbox = store.pendingOutbox().length;

    await service.advanceDemoCycle('demo-house', '2026-11');
    await service.advanceDemoCycle('demo-house', '2026-11');
    expect(billCount()).toBe(2);
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n).toBe(proposals);
    expect(store.pendingOutbox()).toHaveLength(outbox);
    expect(settlementRows()).toHaveLength(1);
    expect(debtRows()[0].remaining_cents).toBe(4_800);
  });

  it('without any debt the new requests are plain equal shares', async () => {
    await service.advanceDemoCycle('demo-house', '2026-11');
    const [bill] = ledger.billsForCycle('demo-house', '2026-11');
    expect(Object.values(ownProposals(bill.billId)).map((p) => p.amountCents)).toEqual([5_000, 5_000, 5_000]);
    expect(settlementRows()).toEqual([]);
  });

  const refused = async (cycleId: string, reason: string) => {
    const error = await service.advanceDemoCycle('demo-house', cycleId).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CycleTransitionError);
    expect((error as CycleTransitionError).reason).toBe(reason);
  };

  it('refuses unknown and non-next cycles without changing anything', async () => {
    await refused('2027-01', 'unknown_cycle');
    await refused('2026-12', 'unknown_cycle');
    expect(ledger.currentCycle('demo-house')).toBe('2026-10');
    expect(billCount()).toBe(0);
  });

  it('refuses while a prior bill is not paid', async () => {
    await run('mason', { kind: 'add_bill', amountCents: 14_400, title: 'Electricity', dueDate: '2026-10-15', recipientId: 'electric', cycleId: '2026-10' });
    await refused('2026-11', 'prior_unpaid');
    expect(ledger.currentCycle('demo-house')).toBe('2026-10');
    expect(billCount()).toBe(1);
  });

  it('refuses while a bank operation is unresolved', async () => {
    const october = await runOctober();
    store.insertBankOperation(
      {
        operationId: 'op-stuck',
        householdId: 'demo-house',
        proposalId: paymentProposal(october).proposalId,
        proposalVersion: 1,
        fromAccountId: 'acct-house',
        toAccountId: 'acct-electric',
        amountCents: 1,
        description: 'stuck',
      },
      NOW,
    );
    store.updateBankOperation('op-stuck', { status: 'unknown' }, NOW);
    await refused('2026-11', 'unresolved_operations');
    expect(ledger.currentCycle('demo-house')).toBe('2026-10');
  });

  it('refuses an unknown household', async () => {
    await expect(service.advanceDemoCycle('nobody', '2026-11')).rejects.toBeInstanceOf(CycleTransitionError);
  });

  it('cannot start a later cycle before the one in between', async () => {
    const three: HouseholdConfig = { ...houseConfig(), demoCycles: [...houseConfig().demoCycles, { cycleId: '2026-12', bills: [] }] };
    await service.bootstrapHousehold(three);
    await refused('2026-12', 'not_next');
  });
});

describe('an incomplete or failed repayment never clears the debt', () => {
  it('a failed repayment leaves the debt; the reissued payment later clears it once', async () => {
    await runOctober();
    await service.advanceDemoCycle('demo-house', '2026-11');
    const own = ownProposals(ledger.billsForCycle('demo-house', '2026-11')[0].billId);
    await approve('alex', own.alex.proposalId);

    bank.inject('fail');
    await approve('jordan', own.jordan.proposalId);
    expect(debtRows()[0].remaining_cents).toBe(4_800);
    expect(settlementRows()[0].status).toBe('pending');
    expect(ledger.proposal(own.jordan.proposalId)).toMatchObject({ version: 2, status: 'proposed', amountCents: 9_800 });

    await approve('jordan', own.jordan.proposalId, 2);
    expect(debtRows()[0].remaining_cents).toBe(0);
    expect(settlementRows()).toHaveLength(1);
    expect(settlementRows()[0].status).toBe('applied');
  });

  it('an unknown repayment keeps the debt open until the bank confirms it', async () => {
    await runOctober();
    await service.advanceDemoCycle('demo-house', '2026-11');
    const own = ownProposals(ledger.billsForCycle('demo-house', '2026-11')[0].billId);
    await approve('alex', own.alex.proposalId);

    bank.setSupportsFindTransfer(false);
    bank.inject('throw-after');
    await approve('jordan', own.jordan.proposalId);
    expect(debtRows()[0].remaining_cents).toBe(4_800);

    bank.setSupportsFindTransfer(true);
    await service.reconcile('demo-house');
    expect(debtRows()[0].remaining_cents).toBe(0);
    expect(bank.submitCalls.filter((c) => c.amountCents === 9_800)).toHaveLength(1);
  });

  it('declining the repayment leaves the debt and the pending settlement untouched', async () => {
    await runOctober();
    await service.advanceDemoCycle('demo-house', '2026-11');
    const own = ownProposals(ledger.billsForCycle('demo-house', '2026-11')[0].billId);
    await run('jordan', { kind: 'decline', proposalId: own.jordan.proposalId, proposalVersion: 1 });
    await approve('alex', own.alex.proposalId);
    expect(debtRows()[0].remaining_cents).toBe(4_800);
    expect(settlementRows()[0].status).toBe('pending');
  });
});

describe('credit is applied once per obligation', () => {
  const debt = (id: string, debtor: string, creditor: string, cents: number) =>
    ledger.insertDebt({ debtId: id, householdId: 'demo-house', debtorId: debtor, creditorId: creditor, originalCents: cents, remainingCents: cents, sourceBillId: 'old' }, NOW);

  it('credit larger than the new share is retained, never a negative request', async () => {
    await boot([{ title: 'Water', amountCents: 3_000, dueDate: '2026-11-15', recipientId: 'electric' }]);
    debt('d1', 'jordan', 'alex', 4_800);
    await service.advanceDemoCycle('demo-house', '2026-11');
    const [bill] = ledger.billsForCycle('demo-house', '2026-11');
    const own = ownProposals(bill.billId);

    expect(own.alex).toBeUndefined(); // Alex's whole 1,000 share is covered, so nothing is requested
    expect(own.mason.amountCents).toBe(1_000);
    expect(own.jordan.amountCents).toBe(2_000);
    expect(Object.values(own).every((p) => p.amountCents > 0)).toBe(true);
    expect(settlementRows()).toEqual([expect.objectContaining({ amount_cents: 1_000 })]);

    await approve('mason', own.mason.proposalId);
    await approve('jordan', own.jordan.proposalId);
    expect(debtRows()[0].remaining_cents).toBe(3_800); // unused credit stays on the debt
    expect(settlementRows()[0].status).toBe('applied');
  });

  it('applies one debt across several new bills in order, with a single settlement', async () => {
    await boot([
      { title: 'Electricity', amountCents: 3_000, dueDate: '2026-11-15', recipientId: 'electric' },
      { title: 'Internet', amountCents: 3_000, dueDate: '2026-11-16', recipientId: 'internet' },
    ]);
    debt('d1', 'jordan', 'alex', 1_500);
    await service.advanceDemoCycle('demo-house', '2026-11');
    const [first, second] = ledger.billsForCycle('demo-house', '2026-11');

    expect(ownProposals(first.billId).alex).toBeUndefined(); // the first bill absorbs Alex's whole 1,000 share
    expect(settlementRows()).toHaveLength(1);
    const applications = JSON.parse(settlementRows()[0].applications_json) as Array<{ billId: string; amountCents: number }>;
    expect(applications.reduce((sum, a) => sum + a.amountCents, 0)).toBe(1_500);
    expect(applications[0]).toEqual({ billId: first.billId, amountCents: 1_000 });
    expect(applications[1]).toEqual({ billId: second.billId, amountCents: 500 });
    expect(ownProposals(second.billId).alex.amountCents).toBe(500);
  });

  it('a debt that already has a settlement is not credited to a bill added later', async () => {
    await runOctober();
    await service.advanceDemoCycle('demo-house', '2026-11');
    await run('mason', { kind: 'add_bill', amountCents: 3_000, title: 'Water', dueDate: '2026-11-20', recipientId: 'electric', cycleId: '2026-11' });
    const water = ledger.billsForCycle('demo-house', '2026-11').find((b) => b.title === 'Water')!;
    expect(Object.values(ownProposals(water.billId)).map((p) => p.amountCents)).toEqual([1_000, 1_000, 1_000]);
    expect(settlementRows()).toHaveLength(1);
  });

  it('coverage and bill edits are not offered on a bill carrying a credit', async () => {
    await runOctober();
    await service.advanceDemoCycle('demo-house', '2026-11');
    const [bill] = ledger.billsForCycle('demo-house', '2026-11');
    expect(await run('jordan', { kind: 'request_coverage', billId: bill.billId })).toMatchObject({ kind: 'rejected', code: 'COVERAGE_UNAVAILABLE' });
    expect(
      await run('mason', { kind: 'correct_bill', billId: bill.billId, amountCents: 16_000, title: 'Electricity', dueDate: '2026-11-15', recipientId: 'electric' }),
    ).toMatchObject({ kind: 'rejected', code: 'ALREADY_SUBMITTED' });
    expect(ledger.bill(bill.billId)!.amountCents).toBe(15_000);
  });
});
