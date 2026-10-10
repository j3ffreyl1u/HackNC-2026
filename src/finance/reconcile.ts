import { formatUsd } from './accounting.js';
import { transferMatches, type BankTransferResult, type BankingAdapter } from './bank.js';
import { Ledger, type ProposalRecord } from './ledger.js';
import type { Clock, IdGenerator } from './runtime.js';
import type { BankOperationRecord, LedgerStore } from './store.js';

/**
 * Sends prepared bank operations and reconciles uncertain ones.
 *
 * Operation lifecycle: prepared (never sent) -> submitted (send attempted, outcome not yet recorded)
 * -> pending | unknown | confirmed | failed. Only `prepared` operations are ever sent. Anything else
 * is resolved by asking the bank, never by sending again, so one approval can move money at most once.
 * Only a bank-reported, matching `confirmed` result counts as paid.
 */
export class BankProcessor {
  private readonly ledger: Ledger;

  constructor(
    private readonly store: LedgerStore,
    private readonly bank: BankingAdapter,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {
    this.ledger = new Ledger(store);
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  /**
   * Resolve every uncertain operation first (so restart recovery precedes new spending), then send
   * prepared ones. A failure on one operation does not stop the others; the first is rethrown at the end.
   */
  async pump(householdId?: string): Promise<void> {
    const operations = this.store.unresolvedBankOperations(householdId);
    const ordered = [
      ...operations.filter((op) => op.status !== 'prepared'),
      ...operations.filter((op) => op.status === 'prepared'),
    ];
    let firstError: unknown;
    for (const op of ordered) {
      try {
        if (op.status === 'prepared') await this.submit(op);
        else await this.resolve(op);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private async submit(op: BankOperationRecord): Promise<void> {
    const claimed = this.store.tx(() => {
      if (!this.store.claimOperationForSubmission(op.operationId, this.now())) return false;
      this.ledger.setProposalStatus(op.proposalId, 'submitted', this.now());
      return true;
    });
    if (!claimed) return;

    let result: BankTransferResult;
    try {
      result = await this.bank.submitTransfer({
        operationId: op.operationId,
        fromAccountId: op.fromAccountId,
        toAccountId: op.toAccountId,
        amountCents: op.amountCents,
        description: op.description,
      });
    } catch (error) {
      // The request may or may not have reached the bank. Never retry; reconcile instead.
      result = { status: 'unknown', reason: `bank error: ${describeError(error)}` };
    }
    this.apply(op.operationId, result);
  }

  private async resolve(op: BankOperationRecord): Promise<void> {
    let result: BankTransferResult | null;
    try {
      result = op.providerTransactionId
        ? await this.bank.getTransfer(op.providerTransactionId)
        : await this.bank.findTransfer(op.operationId, op.fromAccountId);
    } catch (error) {
      result = { status: 'unknown', reason: `bank error: ${describeError(error)}` };
    }
    if (result === null) {
      // The bank positively has no such transfer, so nothing was moved.
      this.apply(op.operationId, { status: 'failed', reason: 'not found at the bank; nothing was moved' });
      return;
    }
    this.apply(op.operationId, result);
  }

  // ---- applying a bank answer -----------------------------------------------

  private apply(operationId: string, result: BankTransferResult): void {
    this.store.tx(() => {
      const op = this.store.getBankOperation(operationId);
      if (!op || op.status === 'confirmed' || op.status === 'failed') return; // already final
      const proposal = this.ledger.proposal(op.proposalId);
      if (!proposal) throw new Error(`operation ${operationId} has no proposal`);

      const providerTransactionId = result.providerTransactionId ?? op.providerTransactionId;
      switch (result.status) {
        case 'confirmed': {
          const matches = transferMatches(result, op);
          if (!providerTransactionId || !matches) {
            this.markUncertain(op, proposal, 'unknown', providerTransactionId, 'the bank result did not match the requested transfer');
            return;
          }
          this.confirm(op, proposal, providerTransactionId);
          return;
        }
        case 'failed':
          this.fail(op, proposal, result.reason);
          return;
        case 'pending':
          this.markUncertain(op, proposal, 'pending', providerTransactionId, result.reason);
          return;
        case 'unknown':
          this.markUncertain(op, proposal, 'unknown', providerTransactionId, result.reason);
          return;
      }
    });
  }

  private markUncertain(
    op: BankOperationRecord,
    proposal: ProposalRecord,
    status: 'pending' | 'unknown',
    providerTransactionId: string | undefined,
    reason: string | undefined,
  ): void {
    const changed = op.status !== status;
    this.store.updateBankOperation(op.operationId, { status, providerTransactionId, reason: clean(reason) }, this.now());
    this.ledger.setProposalStatus(op.proposalId, status, this.now());
    if (!changed) return;
    // Tell the payer once per transition, and never invite another submission.
    const payer = this.payerOf(op);
    if (payer) {
      this.store.enqueueOutbox(
        {
          deliveryId: `deliv:${op.operationId}:${status}`,
          householdId: op.householdId,
          audience: { kind: 'private', userId: payer.userId },
          text: "Payment confirmation is pending. Please don't submit it again while we check.",
        },
        this.now(),
      );
    }
  }

  private confirm(op: BankOperationRecord, proposal: ProposalRecord, providerTransactionId: string): void {
    this.store.updateBankOperation(op.operationId, { status: 'confirmed', providerTransactionId }, this.now());
    this.ledger.setProposalStatus(proposal.proposalId, 'confirmed', this.now());

    const bill = this.ledger.bill(proposal.billId);
    if (proposal.purpose === 'bill_payment') {
      if (bill) this.ledger.setBillStatus(bill.billId, 'paid');
      return;
    }
    for (const line of proposal.allocation) {
      this.ledger.insertAllocation(
        { ...line, allocationId: this.newId('alloc'), billId: proposal.billId, operationId: op.operationId },
        this.now(),
      );
    }
    if (!bill) return;

    const funded = this.ledger.confirmedTotal(bill.billId);
    const payer = this.payerOf(op);
    const progress = `${formatUsd(funded)} of ${formatUsd(bill.amountCents)} funded`;
    const lead = payer ? `${payer.displayName}'s ${formatUsd(op.amountCents)}` : formatUsd(op.amountCents);
    this.groupMessage(op, `deliv:${op.operationId}:confirmed`, `${lead} for ${bill.title} is confirmed (${progress}).`);
    if (funded >= bill.amountCents && bill.status === 'collecting') {
      this.ledger.setBillStatus(bill.billId, 'ready');
      this.groupMessage(op, `deliv:${bill.billId}:funded`, `${bill.title} is fully funded (${formatUsd(funded)}).`);
    }
  }

  /**
   * A definite failure moved no money. Reissue the proposal as a new version so that everyone must
   * approve again; the old message and approvals go stale.
   */
  private fail(op: BankOperationRecord, proposal: ProposalRecord, reason: string | undefined): void {
    this.store.updateBankOperation(op.operationId, { status: 'failed', reason: clean(reason) }, this.now());
    const version = proposal.version + 1;
    this.ledger.reviseProposal(
      proposal.proposalId,
      { version, amountCents: proposal.amountCents, allocation: proposal.allocation, description: proposal.description },
      this.now(),
    );
    const bill = this.ledger.bill(proposal.billId);
    const members = new Map(this.ledger.members(op.householdId).map((m) => [m.userId, m]));
    for (const userId of proposal.requiredActorIds) {
      if (!members.has(userId)) continue;
      this.store.enqueueOutbox(
        {
          deliveryId: `deliv:${proposal.proposalId}:v${version}:retry:${userId}`,
          householdId: op.householdId,
          audience: { kind: 'private', userId },
          text:
            `The ${formatUsd(proposal.amountCents)} transfer for ${bill?.title ?? 'the bill'} did not go through ` +
            `(${clean(reason)}). No money was moved. To try again, react 👍 to this message or reply ` +
            `"approve ${proposal.proposalId} v${version}".`,
          proposalRef: { proposalId: proposal.proposalId, proposalVersion: version },
        },
        this.now(),
      );
    }
  }

  private payerOf(op: BankOperationRecord) {
    return this.ledger.members(op.householdId).find((m) => m.bankAccountId === op.fromAccountId) ?? null;
  }

  private groupMessage(op: BankOperationRecord, deliveryId: string, text: string): void {
    const household = this.ledger.household(op.householdId);
    if (!household) return;
    this.store.enqueueOutbox(
      { deliveryId, householdId: op.householdId, audience: { kind: 'group', spaceId: household.groupSpaceId }, text },
      this.now(),
    );
  }
}

function clean(reason: string | undefined): string {
  return (reason ?? 'no reason given').replace(/\s+/g, ' ').slice(0, 120);
}

function describeError(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error));
}
