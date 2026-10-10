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
  demoCycles: [{ cycleId: '2026-10', bills: [] }],
};

const NOW = '2026-10-10T12:00:00.000Z';
const balances = { 'acct-mason': 100_000, 'acct-alex': 100_000, 'acct-jordan': 100_000, 'acct-house': 0 };

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

const approve = (actor: string, proposalId: string, version = 1) =>
  run(actor, { kind: 'approve', proposalId, proposalVersion: version });

async function addElectricity() {
  await run('mason', {
    kind: 'add_bill',
    amountCents: 14_400,
    title: 'Electricity',
    dueDate: '2026-10-15',
    recipientId: 'electric',
    cycleId: '2026-10',
  });
  const bill = ledger.billsForCycle('demo-house', '2026-10')[0];
  const own = Object.fromEntries(ledger.proposalsForBill(bill.billId).map((p) => [p.requiredActorIds[0], p.proposalId]));
  return { billId: bill.billId, own };
}

/** Jordan asks privately and allows the group to be asked. Returns the request ID. */
async function jordanOpensRequest(billId: string): Promise<string> {
  expect(await run('jordan', { kind: 'request_coverage', billId })).toEqual({ kind: 'accepted' });
  const requestId = (store.db.prepare('SELECT request_id FROM coverage_requests').get() as { request_id: string }).request_id;
  expect(await run('jordan', { kind: 'share_coverage_request', requestId, consent: true })).toEqual({ kind: 'accepted' });
  return requestId;
}

const offer = (actor: string, requestId: string, amountCents = 4_800) =>
  run(actor, { kind: 'offer_coverage', requestId, amountCents });

const coverageProposal = (billId: string) => ledger.proposalsForBill(billId).find((p) => p.purpose === 'coverage');
const debts = () => store.db.prepare('SELECT * FROM debts').all() as Array<Record<string, unknown>>;
const requestRow = (id: string) => ledger.coverageRequest(id)!;
const groupTexts = () => store.pendingOutbox().filter((m) => m.audience.kind === 'group').map((m) => m.text);
const privateTexts = (userId: string) =>
  store.pendingOutbox().filter((m) => m.audience.kind === 'private' && m.audience.userId === userId).map((m) => m.text);

describe('the canonical October coverage story', () => {
  it('runs from private request to confirmed funding and a single 4,800 debt', async () => {
    const { billId, own } = await addElectricity();
    await approve('mason', own.mason);

    const requestId = await jordanOpensRequest(billId);
    expect(requestRow(requestId)).toMatchObject({ status: 'open', debtorId: 'jordan', amountCents: 4_800 });
    expect(debts()).toEqual([]);

    expect(await offer('alex', requestId)).toEqual({ kind: 'accepted' });
    const proposal = coverageProposal(billId)!;
    expect(proposal).toMatchObject({
      purpose: 'coverage',
      version: 1,
      status: 'proposed',
      amountCents: 9_600,
      sourceAccountId: 'acct-alex',
      destinationAccountId: 'acct-house',
      requiredActorIds: ['alex', 'jordan'],
    });
    expect(proposal.allocation).toEqual([
      { payerId: 'alex', beneficiaryId: 'alex', amountCents: 4_800, kind: 'own' },
      { payerId: 'alex', beneficiaryId: 'jordan', amountCents: 4_800, kind: 'coverage' },
    ]);
    // Alex's and Jordan's own 4,800 proposals are replaced; Alex is never collected from twice.
    expect(ledger.proposal(own.alex)!.status).toBe('superseded');
    expect(ledger.proposal(own.jordan)!.status).toBe('superseded');
    expect(requestRow(requestId)).toMatchObject({ status: 'awaiting_approvals', volunteerId: 'alex', proposalId: proposal.proposalId });
    expect(debts()).toEqual([]);
    expect(bank.submitCalls).toHaveLength(1); // only Mason's own contribution so far

    // One approval is not enough, and neither creates a debt or a transfer.
    expect(await approve('alex', proposal.proposalId)).toEqual({ kind: 'accepted' });
    expect(bank.submitCalls).toHaveLength(1);
    expect(debts()).toEqual([]);

    expect(await approve('jordan', proposal.proposalId)).toEqual({ kind: 'accepted' });
    expect(bank.submitCalls).toHaveLength(2);
    expect(bank.submitCalls[1]).toMatchObject({ fromAccountId: 'acct-alex', toAccountId: 'acct-house', amountCents: 9_600 });

    expect(ledger.proposal(proposal.proposalId)!.status).toBe('confirmed');
    expect(requestRow(requestId).status).toBe('funded');
    expect(debts()).toEqual([
      expect.objectContaining({ debtor_id: 'jordan', creditor_id: 'alex', original_cents: 4_800, remaining_cents: 4_800, source_bill_id: billId }),
    ]);

    // 4,800 + 9,600 = the 14,400 bill, attributed to the actual payers and logical beneficiaries.
    expect(ledger.confirmedTotal(billId)).toBe(14_400);
    expect(ledger.confirmedByBeneficiary(billId)).toEqual({ mason: 4_800, alex: 4_800, jordan: 4_800 });
    expect(await bank.getBalance('acct-house')).toBe(14_400);
    expect(await bank.getBalance('acct-alex')).toBe(90_400);
    expect(await bank.getBalance('acct-jordan')).toBe(100_000);
    expect(ledger.bill(billId)!.status).toBe('ready');
  });

  it('proposes only the additional 4,800 when the volunteer already paid their own share', async () => {
    const { billId, own } = await addElectricity();
    await approve('alex', own.alex);
    expect(await bank.getBalance('acct-alex')).toBe(95_200);

    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    const proposal = coverageProposal(billId)!;
    expect(proposal.amountCents).toBe(4_800);
    expect(proposal.allocation).toEqual([{ payerId: 'alex', beneficiaryId: 'jordan', amountCents: 4_800, kind: 'coverage' }]);
    expect(ledger.proposal(own.alex)!.status).toBe('confirmed'); // untouched

    await approve('alex', proposal.proposalId);
    await approve('jordan', proposal.proposalId);
    expect(await bank.getBalance('acct-alex')).toBe(90_400); // 100,000 - 4,800 - 4,800, never 9,600 twice
    expect(ledger.confirmedByBeneficiary(billId)).toEqual({ alex: 4_800, jordan: 4_800 });
    expect(debts()).toHaveLength(1);
  });

  it("Jordan's replaced own proposal can no longer be approved, so nobody is collected from twice", async () => {
    const { billId, own } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    expect(await approve('jordan', own.jordan)).toMatchObject({ kind: 'rejected', code: 'STALE_PROPOSAL' });
    expect(await approve('alex', own.alex)).toMatchObject({ kind: 'rejected', code: 'STALE_PROPOSAL' });
    expect(bank.submitCalls).toHaveLength(0);
  });
});

describe('no debt before bank-confirmed funding', () => {
  async function agreedButUnsent() {
    const { billId, own } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    const proposal = coverageProposal(billId)!;
    await approve('alex', proposal.proposalId);
    return { billId, own, requestId, proposal };
  }

  it('a pending transfer creates no debt until the bank settles it', async () => {
    const { billId, requestId, proposal } = await agreedButUnsent();
    bank.inject('pending');
    await approve('jordan', proposal.proposalId);
    expect(ledger.proposal(proposal.proposalId)!.status).toBe('pending');
    expect(debts()).toEqual([]);
    expect(requestRow(requestId).status).toBe('awaiting_approvals');
    expect(ledger.confirmedTotal(billId)).toBe(0);

    const tx = store.unresolvedBankOperations()[0].providerTransactionId!;
    bank.settle(tx);
    await service.reconcile('demo-house');
    expect(debts()).toHaveLength(1);
    expect(requestRow(requestId).status).toBe('funded');
    await service.reconcile('demo-house');
    expect(debts()).toHaveLength(1); // never twice
  });

  it('an unknown outcome creates no debt and is never retried', async () => {
    const { requestId, proposal } = await agreedButUnsent();
    bank.setSupportsFindTransfer(false);
    bank.inject('throw-after');
    await approve('jordan', proposal.proposalId);
    await service.reconcile('demo-house');
    expect(ledger.proposal(proposal.proposalId)!.status).toBe('unknown');
    expect(debts()).toEqual([]);
    expect(requestRow(requestId).status).toBe('awaiting_approvals');
    expect(bank.submitCalls).toHaveLength(1);
  });

  it('a failed transfer creates no debt; both must approve the reissued version', async () => {
    const { billId, requestId, proposal } = await agreedButUnsent();
    bank.inject('fail');
    await approve('jordan', proposal.proposalId);

    expect(debts()).toEqual([]);
    expect(ledger.confirmedTotal(billId)).toBe(0);
    expect(requestRow(requestId).status).toBe('awaiting_approvals');
    expect(ledger.proposal(proposal.proposalId)).toMatchObject({ version: 2, status: 'proposed' });
    for (const user of ['alex', 'jordan']) {
      expect(privateTexts(user).some((t) => t.includes('No money was moved') && t.includes(`approve ${proposal.proposalId} v2`))).toBe(true);
    }

    expect(await approve('alex', proposal.proposalId, 1)).toMatchObject({ code: 'STALE_PROPOSAL' });
    await approve('alex', proposal.proposalId, 2);
    expect(debts()).toEqual([]);
    await approve('jordan', proposal.proposalId, 2);
    expect(debts()).toHaveLength(1);
    expect(requestRow(requestId).status).toBe('funded');
    expect(await bank.getBalance('acct-house')).toBe(9_600);
  });

  it('requesting and agreeing alone never create a debt or move money', async () => {
    const { billId } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    expect(debts()).toEqual([]);
    expect(bank.submitCalls).toHaveLength(0);
  });
});

describe('private consent', () => {
  it('a private request discloses nothing to the group', async () => {
    const { billId } = await addElectricity();
    const before = groupTexts();
    expect(await run('jordan', { kind: 'request_coverage', billId })).toEqual({ kind: 'accepted' });
    expect(groupTexts()).toEqual(before);

    const prompt = privateTexts('jordan').at(-1)!;
    expect(prompt).toContain('$48.00');
    expect(prompt).toContain('Nothing is shared with the group unless you agree');
    expect(privateTexts('alex').some((t) => t.includes('cov-'))).toBe(false);
    expect(privateTexts('mason').some((t) => t.includes('cov-'))).toBe(false);
  });

  it('declining to share keeps it private forever and blocks offers', async () => {
    const { billId } = await addElectricity();
    await run('jordan', { kind: 'request_coverage', billId });
    const requestId = (store.db.prepare('SELECT request_id FROM coverage_requests').get() as { request_id: string }).request_id;
    const before = groupTexts();

    expect(await run('jordan', { kind: 'share_coverage_request', requestId, consent: false })).toEqual({ kind: 'accepted' });
    expect(requestRow(requestId).status).toBe('closed');
    expect(groupTexts()).toEqual(before);
    expect(groupTexts().join(' ')).not.toContain('Jordan would like help');
    expect(await offer('alex', requestId)).toMatchObject({ kind: 'rejected', code: 'COVERAGE_UNAVAILABLE' });
    expect(coverageProposal(billId)).toBeUndefined();
  });

  it('nobody can offer before the debtor has agreed to share', async () => {
    const { billId } = await addElectricity();
    await run('jordan', { kind: 'request_coverage', billId });
    const requestId = (store.db.prepare('SELECT request_id FROM coverage_requests').get() as { request_id: string }).request_id;
    expect(await offer('alex', requestId)).toMatchObject({ kind: 'rejected', code: 'COVERAGE_UNAVAILABLE' });
    expect(ledger.proposal((await addOwnLookup(billId)).alex)!.status).toBe('proposed');
  });

  async function addOwnLookup(billId: string) {
    return Object.fromEntries(ledger.proposalsForBill(billId).map((p) => [p.requiredActorIds[0], p.proposalId]));
  }

  it('only the debtor can answer the consent question', async () => {
    const { billId } = await addElectricity();
    await run('jordan', { kind: 'request_coverage', billId });
    const requestId = (store.db.prepare('SELECT request_id FROM coverage_requests').get() as { request_id: string }).request_id;
    expect(await run('alex', { kind: 'share_coverage_request', requestId, consent: true })).toMatchObject({
      kind: 'rejected',
      code: 'UNAUTHORIZED_ACTOR',
    });
    expect(requestRow(requestId).status).toBe('awaiting_share_consent');
    expect(groupTexts().join(' ')).not.toContain('would like help');
  });

  it('the group ask names the consenting requester and amount, and only after consent', async () => {
    const { billId } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    const ask = groupTexts().find((t) => t.includes('would like help'))!;
    expect(ask).toContain('Jordan');
    expect(ask).toContain('$48.00');
    expect(ask).toContain(`cover ${requestId} $48.00`);
  });

  it('repeating the request is idempotent, and a second open request is refused', async () => {
    const { billId } = await addElectricity();
    expect(await run('jordan', { kind: 'request_coverage', billId })).toEqual({ kind: 'accepted' });
    const n = store.pendingOutbox().length;
    expect(await run('jordan', { kind: 'request_coverage', billId })).toEqual({ kind: 'duplicate' });
    expect(store.pendingOutbox()).toHaveLength(n);
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM coverage_requests').get() as { n: number }).n).toBe(1);

    const requestId = (store.db.prepare('SELECT request_id FROM coverage_requests').get() as { request_id: string }).request_id;
    await run('jordan', { kind: 'share_coverage_request', requestId, consent: true });
    expect(await run('jordan', { kind: 'share_coverage_request', requestId, consent: true })).toEqual({ kind: 'duplicate' });
    expect(await run('jordan', { kind: 'request_coverage', billId })).toMatchObject({ code: 'COVERAGE_UNAVAILABLE' });
  });

  it('after keeping a request private, the member may ask again later', async () => {
    const { billId } = await addElectricity();
    await run('jordan', { kind: 'request_coverage', billId });
    const first = (store.db.prepare('SELECT request_id FROM coverage_requests').get() as { request_id: string }).request_id;
    await run('jordan', { kind: 'share_coverage_request', requestId: first, consent: false });
    expect(await run('jordan', { kind: 'request_coverage', billId })).toEqual({ kind: 'accepted' });
  });
});

describe('offers', () => {
  it('rejects self-cover, partial and excess amounts, and non-members', async () => {
    const { billId } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    expect(await offer('jordan', requestId)).toMatchObject({ code: 'COVERAGE_UNAVAILABLE' });
    expect(await offer('alex', requestId, 2_400)).toMatchObject({
      kind: 'rejected',
      code: 'INVALID_AMOUNT',
      userMessage: 'I can only arrange coverage for the full remaining $48.00.',
    });
    expect(await offer('alex', requestId, 9_600)).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(await offer('alex', requestId, 48.5)).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(await offer('stranger', requestId)).toMatchObject({ code: 'UNAUTHORIZED_ACTOR' });
    expect(await offer('alex', 'no-such-request')).toMatchObject({ code: 'UNKNOWN_RESOURCE' });
    expect(coverageProposal(billId)).toBeUndefined();
    expect(requestRow(requestId).status).toBe('open');
  });

  it('reserves the request for one volunteer: a competing offer is refused with the standard message', async () => {
    const { billId } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    expect(await offer('mason', requestId)).toEqual({
      kind: 'rejected',
      code: 'COVERAGE_UNAVAILABLE',
      userMessage: 'Another offer is already awaiting confirmation.',
    });
    expect(ledger.proposalsForBill(billId).filter((p) => p.purpose === 'coverage')).toHaveLength(1);
    expect(requestRow(requestId).volunteerId).toBe('alex');
  });

  it('a replayed offer is a duplicate that creates nothing new', async () => {
    const { billId } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    expect(await run('alex', { kind: 'offer_coverage', requestId, amountCents: 4_800 }, 'cmd-offer')).toEqual({ kind: 'accepted' });
    expect(await run('alex', { kind: 'offer_coverage', requestId, amountCents: 4_800 }, 'cmd-offer')).toEqual({ kind: 'duplicate' });
    expect(await offer('alex', requestId)).toEqual({ kind: 'duplicate' }); // same volunteer, new command
    expect(ledger.proposalsForBill(billId).filter((p) => p.purpose === 'coverage')).toHaveLength(1);
  });

  it('refuses when the debtor has already paid, or either side has a payment in flight', async () => {
    const { billId, own } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    ledger.setProposalStatus(own.alex, 'pending', NOW);
    expect(await offer('alex', requestId)).toMatchObject({ code: 'COVERAGE_UNAVAILABLE' });
    ledger.setProposalStatus(own.alex, 'proposed', NOW);

    ledger.setProposalStatus(own.jordan, 'unknown', NOW);
    expect(await offer('alex', requestId)).toMatchObject({ code: 'COVERAGE_UNAVAILABLE' });
    ledger.setProposalStatus(own.jordan, 'proposed', NOW);

    store.db
      .prepare(
        `INSERT INTO allocations (allocation_id, bill_id, payer_id, beneficiary_id, amount_cents, operation_id, kind, created_at)
         VALUES ('al-j', ?, 'jordan', 'jordan', 4800, 'op-j', 'own', ?)`,
      )
      .run(billId, NOW);
    expect(await offer('alex', requestId)).toMatchObject({ code: 'COVERAGE_UNAVAILABLE', userMessage: 'That share has already been paid.' });
    expect(coverageProposal(billId)).toBeUndefined();
  });

  it('the agreement message carries the exact terms and is bound to the proposal version', async () => {
    const { billId } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    const proposal = coverageProposal(billId)!;
    const message = store.pendingOutbox().find((m) => m.proposalRef?.proposalId === proposal.proposalId)!;
    expect(message.audience).toEqual({ kind: 'group', spaceId: 'space-1' });
    expect(message.proposalRef).toEqual({ proposalId: proposal.proposalId, proposalVersion: 1 });
    expect(message.text).toContain('$96.00');
    expect(message.text).toContain('Jordan then owes Alex $48.00');
    expect(message.text).toContain('Nothing moves until both of you approve');
  });

  it('only the two parties can approve the agreement', async () => {
    const { billId } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    const proposal = coverageProposal(billId)!;
    expect(await approve('mason', proposal.proposalId)).toMatchObject({ code: 'UNAUTHORIZED_ACTOR' });
    expect(store.approvalsFor(proposal.proposalId, 1)).toEqual([]);
    expect(bank.submitCalls).toHaveLength(0);
  });
});

describe('a declined agreement', () => {
  it.each(['jordan', 'alex'])('%s declining reopens the request with no transfer and no debt', async (decliner) => {
    const { billId, own } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    const proposal = coverageProposal(billId)!;
    await approve('alex', proposal.proposalId);

    expect(await run(decliner, { kind: 'decline', proposalId: proposal.proposalId, proposalVersion: 1 })).toEqual({ kind: 'accepted' });

    expect(ledger.proposal(proposal.proposalId)!.status).toBe('declined'); // history kept
    expect(requestRow(requestId)).toMatchObject({ status: 'open', supersededProposalIds: [] });
    expect(requestRow(requestId).volunteerId).toBeUndefined();
    expect(debts()).toEqual([]);
    expect(bank.submitCalls).toHaveLength(0);

    // The replaced own-share proposals come back at a new version so nobody is left without one.
    expect(ledger.proposal(own.alex)).toMatchObject({ version: 2, status: 'proposed', amountCents: 4_800 });
    expect(ledger.proposal(own.jordan)).toMatchObject({ version: 2, status: 'proposed', amountCents: 4_800 });

    expect(groupTexts().at(-1)).toContain('nothing was transferred');
    expect(await approve('jordan', proposal.proposalId)).toMatchObject({ code: 'STALE_PROPOSAL' });
  });

  it('the reopened request can be taken by a different volunteer', async () => {
    const { billId, own } = await addElectricity();
    await approve('mason', own.mason);
    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    const first = coverageProposal(billId)!;
    await run('jordan', { kind: 'decline', proposalId: first.proposalId, proposalVersion: 1 });

    expect(await offer('mason', requestId)).toEqual({ kind: 'accepted' });
    const second = ledger.proposalsForBill(billId).filter((p) => p.purpose === 'coverage').at(-1)!;
    expect(second.proposalId).not.toBe(first.proposalId);
    // Mason already paid, so only the additional 4,800 is proposed.
    expect(second).toMatchObject({ amountCents: 4_800, requiredActorIds: ['mason', 'jordan'] });
    await approve('mason', second.proposalId);
    await approve('jordan', second.proposalId);
    expect(debts()).toEqual([expect.objectContaining({ debtor_id: 'jordan', creditor_id: 'mason', remaining_cents: 4_800 })]);
    expect(await bank.getBalance('acct-alex')).toBe(100_000);
  });
});

describe('edits and privacy boundaries', () => {
  it('correcting the bill closes requests that never reached an agreement, and tells the debtor privately', async () => {
    const { billId } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    const correction: CommandPayload = {
      kind: 'correct_bill',
      billId,
      amountCents: 15_000,
      title: 'Electricity',
      dueDate: '2026-10-15',
      recipientId: 'electric',
    };
    expect(await run('mason', correction)).toEqual({ kind: 'accepted' });
    expect(requestRow(requestId).status).toBe('closed');
    expect(privateTexts('jordan').at(-1)).toContain('your coverage request was closed');
    expect(await offer('alex', requestId)).toMatchObject({ code: 'COVERAGE_UNAVAILABLE' });
  });

  it('refuses to edit a bill while a coverage agreement awaits approval', async () => {
    const { billId } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    const result = await run('mason', {
      kind: 'correct_bill',
      billId,
      amountCents: 15_000,
      title: 'Electricity',
      dueDate: '2026-10-15',
      recipientId: 'electric',
    });
    expect(result).toMatchObject({ kind: 'rejected', code: 'ALREADY_SUBMITTED' });
    expect(requestRow(requestId).status).toBe('awaiting_approvals');
  });

  it("a debt appears only in its parties' private summaries", async () => {
    const { billId, own } = await addElectricity();
    await approve('mason', own.mason);
    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    const proposal = coverageProposal(billId)!;
    await approve('alex', proposal.proposalId);
    await approve('jordan', proposal.proposalId);

    for (const user of ['mason', 'alex', 'jordan']) await run(user, { kind: 'get_summary', cycleId: '2026-10' });
    const [mason, alex, jordan] = ['mason', 'alex', 'jordan'].map((u) => privateTexts(u).at(-1)!);
    expect(mason).not.toContain('owe');
    expect(alex).toContain('Jordan owes you $48.00');
    expect(jordan).toContain('You owe Alex $48.00');
  });

  it('unrelated members see no coverage detail in private messages', async () => {
    const { billId } = await addElectricity();
    const requestId = await jordanOpensRequest(billId);
    await offer('alex', requestId);
    expect(privateTexts('mason').join(' ')).not.toContain('Jordan');
    expect(privateTexts('mason').join(' ')).not.toContain('coverage');
  });
});
