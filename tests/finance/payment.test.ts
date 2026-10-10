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
  recipients: [
    { recipientId: 'electric', displayName: 'Power Co', bankAccountId: 'acct-electric' },
    { recipientId: 'internet', displayName: 'Net Co', bankAccountId: 'acct-internet' },
  ],
  demoCycles: [{ cycleId: '2026-10', bills: [] }],
};

const NOW = '2026-10-10T12:00:00.000Z';
const balances = { 'acct-mason': 100_000, 'acct-alex': 100_000, 'acct-jordan': 100_000, 'acct-house': 0, 'acct-electric': 0, 'acct-internet': 0 };

let store: LedgerStore;
let bank: MockBank;
let ledger: Ledger;
let service: FinanceService;
let idCounter = 0;
let cmdCounter = 0;

beforeEach(async () => {
  idCounter = 0;
  cmdCounter = 0;
  store = LedgerStore.open(':memory:');
  bank = new MockBank({ balances });
  ledger = new Ledger(store);
  service = createFinanceService({ store, bank, clock: { now: () => new Date(NOW) }, newId: (prefix) => `${prefix}-${++idCounter}` });
  await service.bootstrapHousehold(config);
});
afterEach(() => store.close());

function run(actorId: string, payload: CommandPayload, commandId = `cmd-${++cmdCounter}`): Promise<ExecuteResult> {
  const command: Command = { commandId, actorId, householdId: 'demo-house', sourceEventId: `evt-${commandId}`, payload };
  return service.execute(command);
}
const approve = (actor: string, proposalId: string, version = 1) => run(actor, { kind: 'approve', proposalId, proposalVersion: version });

async function addBill(title: string, amountCents: number, recipientId: string) {
  await run('mason', { kind: 'add_bill', amountCents, title, dueDate: '2026-10-15', recipientId, cycleId: '2026-10' });
  const bill = ledger.billsForCycle('demo-house', '2026-10').find((b) => b.title === title)!;
  const own = Object.fromEntries(ledger.proposalsForBill(bill.billId).map((p) => [p.requiredActorIds[0], p.proposalId]));
  return { billId: bill.billId, own };
}

async function fundEqually(own: Record<string, string>) {
  for (const user of ['mason', 'alex', 'jordan']) await approve(user, own[user]);
}

const paymentProposal = (billId: string) => ledger.proposalsForBill(billId).find((p) => p.purpose === 'bill_payment');
const groupTexts = () => store.pendingOutbox().filter((m) => m.audience.kind === 'group').map((m) => m.text);
const privateTexts = (userId: string) =>
  store.pendingOutbox().filter((m) => m.audience.kind === 'private' && m.audience.userId === userId).map((m) => m.text);
const payoutCalls = () => bank.submitCalls.filter((c) => c.fromAccountId === 'acct-house');
const operationFor = (proposalId: string) =>
  (store.db.prepare('SELECT * FROM bank_operations WHERE proposal_id = ? ORDER BY created_at, operation_id').all(proposalId) as Array<{
    operation_id: string;
    status: string;
    provider_transaction_id: string | null;
  }>).at(-1)!;

describe('proposing the outgoing payment', () => {
  it('appears once funding is complete, for the designated payer only, and sends nothing', async () => {
    const { billId, own } = await addBill('Electricity', 14_400, 'electric');
    await approve('mason', own.mason);
    await approve('alex', own.alex);
    expect(paymentProposal(billId)).toBeUndefined();
    expect(ledger.bill(billId)!.status).toBe('collecting');

    await approve('jordan', own.jordan);
    const proposal = paymentProposal(billId)!;
    expect(ledger.bill(billId)!.status).toBe('ready');
    expect(proposal).toMatchObject({
      purpose: 'bill_payment',
      version: 1,
      status: 'proposed',
      amountCents: 14_400,
      sourceAccountId: 'acct-house',
      destinationAccountId: 'acct-electric',
      requiredActorIds: ['mason'],
    });

    // Readiness is not permission to pay.
    expect(payoutCalls()).toHaveLength(0);
    expect(await bank.getBalance('acct-house')).toBe(14_400);
    expect(await bank.getBalance('acct-electric')).toBe(0);

    const message = store.pendingOutbox().find((m) => m.proposalRef?.proposalId === proposal.proposalId)!;
    expect(message.audience).toEqual({ kind: 'group', spaceId: 'space-1' });
    expect(message.text).toContain('$144.00');
    expect(message.text).toContain('Power Co');
    expect(message.text).toContain(`approve ${proposal.proposalId} v1`);
    expect(message.text.toLowerCase()).not.toContain('card');
  });

  it('is created exactly once, however often reconciliation runs', async () => {
    const { billId, own } = await addBill('Electricity', 14_400, 'electric');
    await fundEqually(own);
    await service.reconcile('demo-house');
    await service.reconcile('demo-house');
    expect(ledger.proposalsForBill(billId).filter((p) => p.purpose === 'bill_payment')).toHaveLength(1);
    expect(groupTexts().filter((t) => t.includes('ready to pay'))).toHaveLength(1);
  });

  it('also appears after the canonical coverage funding', async () => {
    const { billId, own } = await addBill('Electricity', 14_400, 'electric');
    await approve('mason', own.mason);
    await run('jordan', { kind: 'request_coverage', billId });
    const requestId = (store.db.prepare('SELECT request_id FROM coverage_requests').get() as { request_id: string }).request_id;
    await run('jordan', { kind: 'share_coverage_request', requestId, consent: true });
    await run('alex', { kind: 'offer_coverage', requestId, amountCents: 4_800 });
    const coverage = ledger.proposalsForBill(billId).find((p) => p.purpose === 'coverage')!;
    await approve('alex', coverage.proposalId);
    await approve('jordan', coverage.proposalId);

    expect(ledger.bill(billId)!.status).toBe('ready');
    expect(paymentProposal(billId)).toMatchObject({ amountCents: 14_400, requiredActorIds: ['mason'] });
    expect(payoutCalls()).toHaveLength(0);
  });
});

describe('approving the outgoing payment', () => {
  async function readyBill() {
    const { billId, own } = await addBill('Electricity', 14_400, 'electric');
    await fundEqually(own);
    return { billId, proposal: paymentProposal(billId)! };
  }

  it('pays the recipient exactly once and marks the bill paid', async () => {
    const { billId, proposal } = await readyBill();
    expect(await approve('mason', proposal.proposalId)).toEqual({ kind: 'accepted' });

    expect(payoutCalls()).toHaveLength(1);
    expect(payoutCalls()[0]).toMatchObject({ fromAccountId: 'acct-house', toAccountId: 'acct-electric', amountCents: 14_400 });
    expect(await bank.getBalance('acct-house')).toBe(0);
    expect(await bank.getBalance('acct-electric')).toBe(14_400);
    expect(ledger.bill(billId)!.status).toBe('paid');
    expect(ledger.proposal(proposal.proposalId)!.status).toBe('confirmed');
    expect(groupTexts().at(-1)).toBe('Electricity is paid: $144.00 was sent from the household account to Power Co (simulated).');
  });

  it('only the designated payer can approve it', async () => {
    const { proposal } = await readyBill();
    expect(await approve('alex', proposal.proposalId)).toMatchObject({ kind: 'rejected', code: 'UNAUTHORIZED_ACTOR' });
    expect(await approve('jordan', proposal.proposalId)).toMatchObject({ kind: 'rejected', code: 'UNAUTHORIZED_ACTOR' });
    expect(payoutCalls()).toHaveLength(0);
  });

  it('a stale version, a replay and a repeat approval never pay twice', async () => {
    const { proposal } = await readyBill();
    expect(await approve('mason', proposal.proposalId, 2)).toMatchObject({ code: 'STALE_PROPOSAL' });
    expect(await run('mason', { kind: 'approve', proposalId: proposal.proposalId, proposalVersion: 1 }, 'cmd-pay')).toEqual({ kind: 'accepted' });
    expect(await run('mason', { kind: 'approve', proposalId: proposal.proposalId, proposalVersion: 1 }, 'cmd-pay')).toEqual({ kind: 'duplicate' });
    expect(await approve('mason', proposal.proposalId)).toEqual({ kind: 'duplicate' });
    await service.reconcile('demo-house');
    expect(payoutCalls()).toHaveLength(1);
    expect(await bank.getBalance('acct-electric')).toBe(14_400);
  });

  it('declining only holds the payment; the payer can still approve it later', async () => {
    const { billId, proposal } = await readyBill();
    expect(await run('mason', { kind: 'decline', proposalId: proposal.proposalId, proposalVersion: 1 })).toEqual({ kind: 'accepted' });
    expect(payoutCalls()).toHaveLength(0);
    expect(ledger.bill(billId)!.status).toBe('ready');

    expect(await approve('mason', proposal.proposalId)).toEqual({ kind: 'accepted' });
    expect(payoutCalls()).toHaveLength(1);
    expect(ledger.bill(billId)!.status).toBe('paid');
  });

  it('a paid bill cannot be paid again', async () => {
    const { proposal } = await readyBill();
    await approve('mason', proposal.proposalId);
    // A second proposal for the same bill would be refused even if one existed.
    const again = { ...proposal, proposalId: 'prop-again', status: 'proposed' as const };
    ledger.insertProposal(again, NOW);
    expect(await approve('mason', 'prop-again')).toMatchObject({ code: 'ALREADY_SUBMITTED' });
    expect(payoutCalls()).toHaveLength(1);
  });
});

describe('outgoing payment outcomes', () => {
  async function approvedReady(inject?: Parameters<MockBank['inject']>[0]) {
    const { billId, own } = await addBill('Electricity', 14_400, 'electric');
    await fundEqually(own);
    const proposal = paymentProposal(billId)!;
    if (inject) bank.inject(inject);
    await approve('mason', proposal.proposalId);
    return { billId, proposal };
  }

  it('a failed payment leaves the bill ready and is reissued for fresh approval', async () => {
    const { billId, proposal } = await approvedReady('fail');
    expect(ledger.bill(billId)!.status).toBe('ready');
    expect(await bank.getBalance('acct-house')).toBe(14_400);
    expect(ledger.proposal(proposal.proposalId)).toMatchObject({ version: 2, status: 'proposed' });
    expect(privateTexts('mason').at(-1)).toContain('No money was moved');

    expect(await approve('mason', proposal.proposalId, 1)).toMatchObject({ code: 'STALE_PROPOSAL' });
    expect(await approve('mason', proposal.proposalId, 2)).toEqual({ kind: 'accepted' });
    expect(ledger.bill(billId)!.status).toBe('paid');
    expect(await bank.getBalance('acct-electric')).toBe(14_400);
    expect(payoutCalls()).toHaveLength(2);
    expect(new Set(payoutCalls().map((c) => c.operationId)).size).toBe(2);
  });

  it('an unknown payment is not called paid, is not retried, and resolves by lookup', async () => {
    bank.setSupportsFindTransfer(false);
    const { billId, proposal } = await approvedReady('throw-after');
    expect(ledger.bill(billId)!.status).toBe('ready');
    expect(ledger.proposal(proposal.proposalId)!.status).toBe('unknown');
    expect(privateTexts('mason').at(-1)).toBe("Payment confirmation is pending. Please don't submit it again while we check.");
    expect(await approve('mason', proposal.proposalId)).toEqual({ kind: 'duplicate' });
    await service.reconcile('demo-house');
    expect(payoutCalls()).toHaveLength(1);
    expect(ledger.bill(billId)!.status).toBe('ready');

    bank.setSupportsFindTransfer(true);
    await service.reconcile('demo-house');
    expect(ledger.bill(billId)!.status).toBe('paid');
    expect(payoutCalls()).toHaveLength(1); // the money moved once, and was only ever sent once
    expect(await bank.getBalance('acct-electric')).toBe(14_400);
  });

  it('a pending payment is paid only after the bank settles it', async () => {
    const { billId, proposal } = await approvedReady('pending');
    expect(ledger.bill(billId)!.status).toBe('ready');
    expect(await bank.getBalance('acct-electric')).toBe(0);
    bank.settle(operationFor(proposal.proposalId).provider_transaction_id!);
    await service.reconcile('demo-house');
    expect(ledger.bill(billId)!.status).toBe('paid');
    expect(await bank.getBalance('acct-electric')).toBe(14_400);
  });
});

describe('waiting behind unresolved transfers', () => {
  it('an approved payment is held while an earlier transfer is unresolved, then sent once it resolves', async () => {
    const electricity = await addBill('Electricity', 14_400, 'electric');
    await fundEqually(electricity.own);
    const internet = await addBill('Internet', 9_000, 'internet');

    bank.setSupportsFindTransfer(false);
    bank.inject('throw-after'); // Mason's internet contribution leaves the bank with an unknown outcome
    await approve('mason', internet.own.mason);
    expect(store.unresolvedBankOperations().map((o) => o.status)).toEqual(['unknown']);

    const payment = paymentProposal(electricity.billId)!;
    expect(await approve('mason', payment.proposalId)).toEqual({ kind: 'accepted' });
    expect(payoutCalls()).toHaveLength(0); // held, not sent
    expect(await bank.getBalance('acct-electric')).toBe(0);
    expect(store.getBankOperation(operationFor(payment.proposalId).operation_id)!.status).toBe('prepared');
    expect(privateTexts('mason').at(-1)).toContain('waiting for an earlier transfer');

    await service.reconcile('demo-house'); // still cannot be proven
    expect(payoutCalls()).toHaveLength(0);

    bank.setSupportsFindTransfer(true);
    await service.reconcile('demo-house');
    expect(payoutCalls()).toHaveLength(1);
    expect(ledger.bill(electricity.billId)!.status).toBe('paid');
    expect(await bank.getBalance('acct-electric')).toBe(14_400);
  });
});

describe('funds are reserved by bill', () => {
  it('reports each bill\'s own reserved money and releases it only when that bill is paid', async () => {
    const electricity = await addBill('Electricity', 14_400, 'electric');
    const internet = await addBill('Internet', 9_000, 'internet');
    await fundEqually(electricity.own);
    await approve('mason', internet.own.mason);

    expect(ledger.reservedFunds(electricity.billId)).toBe(14_400);
    expect(ledger.reservedFunds(internet.billId)).toBe(3_000);
    expect(await bank.getBalance('acct-house')).toBe(17_400);

    await approve('mason', paymentProposal(electricity.billId)!.proposalId);
    expect(ledger.reservedFunds(electricity.billId)).toBe(0);
    expect(ledger.reservedFunds(internet.billId)).toBe(3_000); // untouched by the other bill's payment
    expect(await bank.getBalance('acct-house')).toBe(3_000);
  });

  it("a bill cannot spend another bill's money even when the account holds enough", async () => {
    const electricity = await addBill('Electricity', 14_400, 'electric');
    const internet = await addBill('Internet', 9_000, 'internet');
    await fundEqually(electricity.own);
    await approve('mason', internet.own.mason);
    expect(await bank.getBalance('acct-house')).toBeGreaterThanOrEqual(9_000);

    // A payment for the under-funded bill, as if it had been created wrongly.
    ledger.insertProposal(
      {
        proposalId: 'rogue',
        householdId: 'demo-house',
        billId: internet.billId,
        purpose: 'bill_payment',
        version: 1,
        status: 'proposed',
        amountCents: 9_000,
        sourceAccountId: 'acct-house',
        destinationAccountId: 'acct-internet',
        requiredActorIds: ['mason'],
        allocation: [],
        description: 'rogue',
      },
      NOW,
    );
    expect(await approve('mason', 'rogue')).toMatchObject({ kind: 'rejected', code: 'INSUFFICIENT_HOUSE_FUNDS' });

    ledger.setBillStatus(internet.billId, 'ready'); // even if wrongly marked ready
    expect(await approve('mason', 'rogue')).toMatchObject({ kind: 'rejected', code: 'INSUFFICIENT_HOUSE_FUNDS' });
    expect(payoutCalls()).toHaveLength(0);
    expect(await bank.getBalance('acct-internet')).toBe(0);
  });

  it('the send-time check refuses an underfunded payment that slipped through, without calling the bank', async () => {
    const electricity = await addBill('Electricity', 14_400, 'electric');
    const internet = await addBill('Internet', 9_000, 'internet');
    await fundEqually(electricity.own);
    await approve('mason', internet.own.mason);

    ledger.insertProposal(
      {
        proposalId: 'rogue',
        householdId: 'demo-house',
        billId: internet.billId,
        purpose: 'bill_payment',
        version: 1,
        status: 'approved',
        amountCents: 9_000,
        sourceAccountId: 'acct-house',
        destinationAccountId: 'acct-internet',
        requiredActorIds: ['mason'],
        allocation: [],
        description: 'rogue',
      },
      NOW,
    );
    store.insertBankOperation(
      {
        operationId: 'op-rogue',
        householdId: 'demo-house',
        proposalId: 'rogue',
        proposalVersion: 1,
        fromAccountId: 'acct-house',
        toAccountId: 'acct-internet',
        amountCents: 9_000,
        description: 'rogue',
      },
      NOW,
    );
    await service.reconcile('demo-house');

    expect(store.getBankOperation('op-rogue')).toMatchObject({ status: 'failed' });
    expect(payoutCalls()).toHaveLength(0);
    expect(await bank.getBalance('acct-house')).toBe(17_400);
    expect(privateTexts('mason').at(-1)).toContain("doesn't have enough confirmed funds reserved");
  });

  it('two funded bills each pay once from their own money', async () => {
    const electricity = await addBill('Electricity', 14_400, 'electric');
    const internet = await addBill('Internet', 9_000, 'internet');
    await fundEqually(electricity.own);
    await fundEqually(internet.own);
    expect(await bank.getBalance('acct-house')).toBe(23_400);

    await approve('mason', paymentProposal(electricity.billId)!.proposalId);
    await approve('mason', paymentProposal(internet.billId)!.proposalId);
    await service.reconcile('demo-house');

    expect(payoutCalls()).toHaveLength(2);
    expect(await bank.getBalance('acct-electric')).toBe(14_400);
    expect(await bank.getBalance('acct-internet')).toBe(9_000);
    expect(await bank.getBalance('acct-house')).toBe(0);
    expect(ledger.bill(electricity.billId)!.status).toBe('paid');
    expect(ledger.bill(internet.billId)!.status).toBe('paid');
  });
});
