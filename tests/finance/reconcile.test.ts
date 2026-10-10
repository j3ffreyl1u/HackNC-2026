import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BankTransferResult, BankingAdapter, SubmitTransferInput } from '../../src/finance/bank';
import type { Command, CommandPayload, ExecuteResult, HouseholdConfig } from '../../src/finance/contracts-local';
import { createFinanceService, type FinanceService } from '../../src/finance/index';
import { Ledger } from '../../src/finance/ledger';
import { MockBank } from '../../src/finance/mock-bank';
import { LedgerStore } from '../../src/finance/store';

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
const startingBalances = { 'acct-mason': 100_000, 'acct-alex': 100_000, 'acct-jordan': 100_000, 'acct-house': 0 };

let store: LedgerStore;
let bank: MockBank;
let ledger: Ledger;
let service: FinanceService;
let idCounter = 0;
let cmdCounter = 0;

function makeService(forStore: LedgerStore, forBank: BankingAdapter): FinanceService {
  return createFinanceService({
    store: forStore,
    bank: forBank,
    clock: { now: () => new Date(NOW) },
    newId: (prefix) => `${prefix}-${++idCounter}`,
  });
}

beforeEach(async () => {
  idCounter = 0;
  cmdCounter = 0;
  store = LedgerStore.open(':memory:');
  bank = new MockBank({ balances: startingBalances });
  ledger = new Ledger(store);
  service = makeService(store, bank);
  await service.bootstrapHousehold(config);
});
afterEach(() => store.close());

function run(svc: FinanceService, actorId: string, payload: CommandPayload, commandId = `cmd-${++cmdCounter}`): Promise<ExecuteResult> {
  const command: Command = { commandId, actorId, householdId: 'demo-house', sourceEventId: `evt-${commandId}`, payload };
  return svc.execute(command);
}

async function addElectricity(svc = service): Promise<{ billId: string; proposalIds: Record<string, string> }> {
  await run(svc, 'mason', {
    kind: 'add_bill',
    amountCents: 14_400,
    title: 'Electricity',
    dueDate: '2026-10-15',
    recipientId: 'electric',
    cycleId: '2026-10',
  });
  const bill = ledger.billsForCycle('demo-house', '2026-10')[0];
  const proposalIds = Object.fromEntries(ledger.proposalsForBill(bill.billId).map((p) => [p.requiredActorIds[0], p.proposalId]));
  return { billId: bill.billId, proposalIds };
}

const approve = (actor: string, proposalId: string, version = 1, svc = service) =>
  run(svc, actor, { kind: 'approve', proposalId, proposalVersion: version });

const operations = () => store.db.prepare('SELECT * FROM bank_operations ORDER BY created_at, operation_id').all() as Array<{
  operation_id: string;
  status: string;
  provider_transaction_id: string | null;
  proposal_id: string;
  proposal_version: number;
}>;
const allocationCount = () => (store.db.prepare('SELECT COUNT(*) AS n FROM allocations').get() as { n: number }).n;
const messagesTo = (userId: string) =>
  store.pendingOutbox().filter((m) => m.audience.kind === 'private' && m.audience.userId === userId);

describe('confirmed contribution', () => {
  it('sends exactly one transfer for the approved amount and records it as paid', async () => {
    const { billId, proposalIds } = await addElectricity();
    expect(await approve('mason', proposalIds.mason)).toEqual({ kind: 'accepted' });

    expect(bank.submitCalls).toHaveLength(1);
    expect(bank.submitCalls[0]).toMatchObject({ fromAccountId: 'acct-mason', toAccountId: 'acct-house', amountCents: 4_800 });
    expect(await bank.getBalance('acct-mason')).toBe(95_200);
    expect(await bank.getBalance('acct-house')).toBe(4_800);

    const [op] = operations();
    expect(op).toMatchObject({ status: 'confirmed', proposal_id: proposalIds.mason, proposal_version: 1 });
    expect(op.provider_transaction_id).toBeTruthy();
    expect(ledger.proposal(proposalIds.mason)!.status).toBe('confirmed');
    expect(ledger.confirmedByBeneficiary(billId)).toEqual({ mason: 4_800 });
    expect(ledger.confirmedTotal(billId)).toBe(4_800);
    expect(ledger.bill(billId)!.status).toBe('collecting');
  });

  it('announces confirmation with progress to the group', async () => {
    const { proposalIds } = await addElectricity();
    await approve('mason', proposalIds.mason);
    const confirmation = store.pendingOutbox().find((m) => m.text.includes('is confirmed'))!;
    expect(confirmation.audience).toEqual({ kind: 'group', spaceId: 'space-1' });
    expect(confirmation.text).toBe("Mason's $48.00 for Electricity is confirmed ($48.00 of $144.00 funded).");
  });

  it('persists the operation before the bank is called', async () => {
    const seen: string[] = [];
    const inner = new MockBank({ balances: startingBalances });
    const spy: BankingAdapter = {
      getBalance: (id) => inner.getBalance(id),
      getTransfer: (id) => inner.getTransfer(id),
      findTransfer: (op, from) => inner.findTransfer(op, from),
      submitTransfer: (input: SubmitTransferInput) => {
        seen.push(store.getBankOperation(input.operationId)?.status ?? 'missing');
        return inner.submitTransfer(input);
      },
    };
    const svc = makeService(store, spy);
    const { proposalIds } = await addElectricity(svc);
    await approve('mason', proposalIds.mason, 1, svc);
    expect(seen).toEqual(['submitted']);
  });

  it('marks the bill ready once confirmed funding reaches the bill amount, only then', async () => {
    const { billId, proposalIds } = await addElectricity();
    await approve('mason', proposalIds.mason);
    await approve('alex', proposalIds.alex);
    expect(ledger.bill(billId)!.status).toBe('collecting');
    await approve('jordan', proposalIds.jordan);

    expect(ledger.bill(billId)!.status).toBe('ready');
    expect(ledger.confirmedTotal(billId)).toBe(14_400);
    expect(await bank.getBalance('acct-house')).toBe(14_400);
    expect(store.pendingOutbox().filter((m) => m.text.includes('fully funded'))).toHaveLength(1);
    expect(new Set(operations().map((o) => o.operation_id)).size).toBe(3);
  });

  it('does not send anything for unapproved, declined or wrongly-approved proposals', async () => {
    const { proposalIds } = await addElectricity();
    await approve('alex', proposalIds.mason); // wrong person
    await run(service, 'jordan', { kind: 'decline', proposalId: proposalIds.jordan, proposalVersion: 1 });
    await approve('alex', proposalIds.mason, 7); // stale version
    expect(bank.submitCalls).toHaveLength(0);
    expect(operations()).toEqual([]);
  });

  it('a replayed command or repeated approval never sends a second transfer', async () => {
    const { proposalIds } = await addElectricity();
    expect(await run(service, 'mason', { kind: 'approve', proposalId: proposalIds.mason, proposalVersion: 1 }, 'cmd-same')).toEqual({
      kind: 'accepted',
    });
    expect(await run(service, 'mason', { kind: 'approve', proposalId: proposalIds.mason, proposalVersion: 1 }, 'cmd-same')).toEqual({
      kind: 'duplicate',
    });
    expect(await approve('mason', proposalIds.mason)).toEqual({ kind: 'duplicate' });
    await service.reconcile('demo-house');
    expect(bank.submitCalls).toHaveLength(1);
    expect(allocationCount()).toBe(1);
  });

  it('reconcile after settlement changes nothing', async () => {
    const { proposalIds } = await addElectricity();
    await approve('mason', proposalIds.mason);
    const outbox = store.pendingOutbox().length;
    await service.reconcile('demo-house');
    await service.reconcile('demo-house');
    expect(allocationCount()).toBe(1);
    expect(store.pendingOutbox()).toHaveLength(outbox);
    expect(await bank.getBalance('acct-house')).toBe(4_800);
  });
});

describe('failed transfer', () => {
  it('is never counted as paid and is reissued as a new version', async () => {
    const { billId, proposalIds } = await addElectricity();
    bank.inject('fail');
    expect(await approve('mason', proposalIds.mason)).toEqual({ kind: 'accepted' });

    expect(operations()[0]).toMatchObject({ status: 'failed' });
    expect(allocationCount()).toBe(0);
    expect(ledger.confirmedTotal(billId)).toBe(0);
    expect(await bank.getBalance('acct-house')).toBe(0);
    expect(ledger.proposal(proposalIds.mason)).toMatchObject({ version: 2, status: 'proposed' });

    const retry = messagesTo('mason').at(-1)!;
    expect(retry.proposalRef).toEqual({ proposalId: proposalIds.mason, proposalVersion: 2 });
    expect(retry.text).toContain('No money was moved');
    expect(retry.text).toContain(`approve ${proposalIds.mason} v2`);
  });

  it('makes the old approval stale, and a fresh approval sends one new transfer', async () => {
    const { billId, proposalIds } = await addElectricity();
    bank.inject('fail');
    await approve('mason', proposalIds.mason);

    expect(await approve('mason', proposalIds.mason, 1)).toMatchObject({ kind: 'rejected', code: 'STALE_PROPOSAL' });
    expect(bank.submitCalls).toHaveLength(1);

    expect(await approve('mason', proposalIds.mason, 2)).toEqual({ kind: 'accepted' });
    expect(bank.submitCalls).toHaveLength(2);
    expect(new Set(bank.submitCalls.map((c) => c.operationId)).size).toBe(2);
    expect(ledger.confirmedByBeneficiary(billId)).toEqual({ mason: 4_800 });
    expect(await bank.getBalance('acct-house')).toBe(4_800);
  });

  it('treats insufficient funds as a failure with the reason in the message', async () => {
    const { proposalIds } = await addElectricity();
    bank.setBalance('acct-jordan', 1_000);
    await approve('jordan', proposalIds.jordan);
    expect(operations()[0]).toMatchObject({ status: 'failed' });
    expect(messagesTo('jordan').at(-1)!.text).toContain('insufficient funds');
    expect(await bank.getBalance('acct-jordan')).toBe(1_000);
  });
});

describe('uncertain transfer', () => {
  it('a timeout after the bank accepted stays unknown, is not counted, and is not retried', async () => {
    const { billId, proposalIds } = await addElectricity();
    bank.setSupportsFindTransfer(false);
    bank.inject('throw-after');
    expect(await approve('mason', proposalIds.mason)).toEqual({ kind: 'accepted' });

    expect(operations()[0]).toMatchObject({ status: 'unknown' });
    expect(ledger.proposal(proposalIds.mason)!.status).toBe('unknown');
    expect(allocationCount()).toBe(0);
    expect(ledger.confirmedTotal(billId)).toBe(0);
    expect(messagesTo('mason').at(-1)!.text).toBe("Payment confirmation is pending. Please don't submit it again while we check.");

    const outbox = store.pendingOutbox().length;
    await service.reconcile('demo-house');
    await service.reconcile('demo-house');
    expect(bank.submitCalls).toHaveLength(1); // never resubmitted
    expect(operations()[0]).toMatchObject({ status: 'unknown' }); // cannot be proven, so it stays unresolved
    expect(allocationCount()).toBe(0);
    expect(store.pendingOutbox()).toHaveLength(outbox); // and does not spam
  });

  it('reconciliation by operation lookup later confirms it without resubmitting', async () => {
    const { billId, proposalIds } = await addElectricity();
    bank.inject('throw-after');
    await approve('mason', proposalIds.mason);
    // The pump inside execute already reconciles only previously-unresolved work; run it explicitly.
    await service.reconcile('demo-house');

    expect(operations()[0]).toMatchObject({ status: 'confirmed' });
    expect(ledger.confirmedByBeneficiary(billId)).toEqual({ mason: 4_800 });
    expect(bank.submitCalls).toHaveLength(1);
    expect(await bank.getBalance('acct-house')).toBe(4_800);
    await service.reconcile('demo-house');
    expect(allocationCount()).toBe(1);
  });

  it('a request that never reached the bank is failed only after the bank confirms it has no record', async () => {
    const { billId, proposalIds } = await addElectricity();
    bank.inject('throw-before');
    await approve('mason', proposalIds.mason);
    expect(operations()[0]).toMatchObject({ status: 'unknown' });

    await service.reconcile('demo-house');
    expect(operations()[0]).toMatchObject({ status: 'failed' });
    expect(bank.submitCalls).toHaveLength(1);
    expect(ledger.confirmedTotal(billId)).toBe(0);
    expect(ledger.proposal(proposalIds.mason)).toMatchObject({ version: 2, status: 'proposed' });
  });

  it('an ambiguous answer stays unresolved until the bank reports on the transfer it holds', async () => {
    const { billId, proposalIds } = await addElectricity();
    bank.inject('unknown-response');
    await approve('mason', proposalIds.mason);
    expect(operations()[0]).toMatchObject({ status: 'unknown' });
    expect(allocationCount()).toBe(0);

    await service.reconcile('demo-house'); // the bank holds it as pending
    expect(operations()[0]).toMatchObject({ status: 'pending' });
    expect(operations()[0].provider_transaction_id).toBeTruthy();
    expect(allocationCount()).toBe(0);

    bank.settle(operations()[0].provider_transaction_id!);
    await service.reconcile('demo-house');
    expect(operations()[0]).toMatchObject({ status: 'confirmed' });
    expect(ledger.confirmedByBeneficiary(billId)).toEqual({ mason: 4_800 });
    expect(bank.submitCalls).toHaveLength(1);
  });

  it('a confirmed answer that does not match the request is not treated as paid', async () => {
    const inner = new MockBank({ balances: startingBalances });
    const lying: BankingAdapter = {
      getBalance: (id) => inner.getBalance(id),
      getTransfer: (id) => inner.getTransfer(id),
      findTransfer: (op, from) => inner.findTransfer(op, from),
      submitTransfer: async (input): Promise<BankTransferResult> => ({
        status: 'confirmed',
        providerTransactionId: 'tx-x',
        amountCents: input.amountCents - 1,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
      }),
    };
    const svc = makeService(store, lying);
    const { billId, proposalIds } = await addElectricity(svc);
    await approve('mason', proposalIds.mason, 1, svc);
    expect(operations()[0]).toMatchObject({ status: 'unknown' });
    expect(ledger.confirmedTotal(billId)).toBe(0);
  });

  it('a confirmed answer without a transaction ID is not treated as paid', async () => {
    const noId: BankingAdapter = {
      getBalance: async () => 0,
      getTransfer: async () => ({ status: 'unknown' }),
      findTransfer: async () => ({ status: 'unknown' }),
      submitTransfer: async (input) => ({
        status: 'confirmed',
        amountCents: input.amountCents,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
      }),
    };
    const svc = makeService(store, noId);
    const { billId, proposalIds } = await addElectricity(svc);
    await approve('mason', proposalIds.mason, 1, svc);
    expect(operations()[0]).toMatchObject({ status: 'unknown' });
    expect(ledger.confirmedTotal(billId)).toBe(0);
  });

  it('a bank error while checking leaves the operation unresolved', async () => {
    const { proposalIds } = await addElectricity();
    bank.setSupportsFindTransfer(false);
    bank.inject('throw-after');
    await approve('mason', proposalIds.mason);
    const flaky: BankingAdapter = {
      getBalance: async () => 0,
      getTransfer: async () => {
        throw new Error('network down');
      },
      findTransfer: async () => {
        throw new Error('network down');
      },
      submitTransfer: async () => {
        throw new Error('must not be called');
      },
    };
    await makeService(store, flaky).reconcile('demo-house');
    expect(operations()[0]).toMatchObject({ status: 'unknown' });
  });
});

describe('pending transfer', () => {
  it('is not counted until the bank settles it, then counts exactly once', async () => {
    const { billId, proposalIds } = await addElectricity();
    bank.inject('pending');
    await approve('mason', proposalIds.mason);

    expect(operations()[0]).toMatchObject({ status: 'pending' });
    expect(ledger.proposal(proposalIds.mason)!.status).toBe('pending');
    expect(allocationCount()).toBe(0);
    const providerId = operations()[0].provider_transaction_id!;
    expect(providerId).toBeTruthy();

    const outbox = store.pendingOutbox().length;
    await service.reconcile('demo-house');
    expect(operations()[0]).toMatchObject({ status: 'pending' });
    expect(store.pendingOutbox()).toHaveLength(outbox);

    bank.settle(providerId);
    await service.reconcile('demo-house');
    await service.reconcile('demo-house');
    expect(operations()[0]).toMatchObject({ status: 'confirmed' });
    expect(ledger.confirmedByBeneficiary(billId)).toEqual({ mason: 4_800 });
    expect(allocationCount()).toBe(1);
    expect(bank.submitCalls).toHaveLength(1);
  });

  it('a pending transfer that the bank later fails is reissued, with nothing counted', async () => {
    const { billId, proposalIds } = await addElectricity();
    bank.inject('pending');
    await approve('mason', proposalIds.mason);
    bank.settle(operations()[0].provider_transaction_id!, 'failed');
    await service.reconcile('demo-house');

    expect(operations()[0]).toMatchObject({ status: 'failed' });
    expect(ledger.confirmedTotal(billId)).toBe(0);
    expect(ledger.proposal(proposalIds.mason)).toMatchObject({ version: 2, status: 'proposed' });
  });
});

describe('recovery', () => {
  it('sends a never-sent (prepared) operation exactly once, even under concurrent reconcile calls', async () => {
    const { proposalIds } = await addElectricity();
    ledger.setProposalStatus(proposalIds.alex, 'approved', NOW);
    store.recordApproval(proposalIds.alex, 1, 'alex', NOW);
    store.insertBankOperation(
      {
        operationId: 'op-prepared',
        householdId: 'demo-house',
        proposalId: proposalIds.alex,
        proposalVersion: 1,
        fromAccountId: 'acct-alex',
        toAccountId: 'acct-house',
        amountCents: 4_800,
        description: 'recovered',
      },
      NOW,
    );
    await Promise.all([service.reconcile('demo-house'), service.reconcile('demo-house'), service.reconcile('demo-house')]);
    expect(bank.submitCalls).toHaveLength(1);
    expect(store.getBankOperation('op-prepared')).toMatchObject({ status: 'confirmed' });
    expect(allocationCount()).toBe(1);
  });

  it('resolves a send that was interrupted mid-flight by asking the bank, not by resending', async () => {
    const { billId, proposalIds } = await addElectricity();
    // Simulate: the app marked the operation submitted, the bank executed it, then the app died.
    store.insertBankOperation(
      {
        operationId: 'op-interrupted',
        householdId: 'demo-house',
        proposalId: proposalIds.alex,
        proposalVersion: 1,
        fromAccountId: 'acct-alex',
        toAccountId: 'acct-house',
        amountCents: 4_800,
        description: 'interrupted',
      },
      NOW,
    );
    store.claimOperationForSubmission('op-interrupted', NOW);
    await bank.submitTransfer({
      operationId: 'op-interrupted',
      fromAccountId: 'acct-alex',
      toAccountId: 'acct-house',
      amountCents: 4_800,
      description: 'interrupted',
    });
    ledger.setProposalStatus(proposalIds.alex, 'submitted', NOW);

    await service.reconcile('demo-house');
    expect(store.getBankOperation('op-interrupted')).toMatchObject({ status: 'confirmed' });
    expect(bank.submitCalls).toHaveLength(1);
    expect(ledger.confirmedByBeneficiary(billId)).toEqual({ alex: 4_800 });
    expect(await bank.getBalance('acct-house')).toBe(4_800);
  });

  describe('across a real restart', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'splitbot-reconcile-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('an unknown transfer survives, and the restarted app resolves it without a second transfer', async () => {
      const path = join(dir, 'ledger.sqlite');
      const first = LedgerStore.open(path);
      const firstService = makeService(first, bank);
      await firstService.bootstrapHousehold(config);
      const firstLedger = new Ledger(first);
      await run(firstService, 'mason', {
        kind: 'add_bill',
        amountCents: 14_400,
        title: 'Electricity',
        dueDate: '2026-10-15',
        recipientId: 'electric',
        cycleId: '2026-10',
      });
      const bill = firstLedger.billsForCycle('demo-house', '2026-10')[0];
      const masonProposal = firstLedger.proposalsForBill(bill.billId).find((p) => p.requiredActorIds[0] === 'mason')!;
      bank.inject('throw-after');
      await run(firstService, 'mason', { kind: 'approve', proposalId: masonProposal.proposalId, proposalVersion: 1 });
      expect(first.unresolvedBankOperations()).toHaveLength(1);
      await firstService.close();

      const second = LedgerStore.open(path);
      const secondService = makeService(second, bank);
      expect(second.unresolvedBankOperations().map((o) => o.status)).toEqual(['unknown']);
      await secondService.reconcile('demo-house');

      expect(second.unresolvedBankOperations()).toEqual([]);
      expect(new Ledger(second).confirmedByBeneficiary(bill.billId)).toEqual({ mason: 4_800 });
      expect(bank.submitCalls).toHaveLength(1);
      expect(await bank.getBalance('acct-house')).toBe(4_800);
      await secondService.close();
    });
  });
});
