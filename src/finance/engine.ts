import { formatUsd, splitEqual } from './accounting.js';
import type { Command, ExecuteResult } from '../contracts/index.js';
import {
  Ledger,
  TERMINAL_PROPOSAL_STATUSES,
  type AllocationLine,
  type BillRecord,
  type ProposalRecord,
} from './ledger.js';
import { Billing } from './billing.js';
import { CoverageFlow } from './coverage.js';
import type { Clock, IdGenerator } from './runtime.js';
import type { LedgerStore } from './store.js';
import { Notifier, Rejection, STALE_MESSAGE, reject, type Context } from './support.js';

/** Proposal statuses after an approved proposal has been handed to the bank. */
const IN_BANK_STATUSES = ['submitted', 'pending', 'unknown', 'confirmed'];

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

export class FinanceEngine {
  private readonly ledger: Ledger;
  private readonly notify: Notifier;
  private readonly coverage: CoverageFlow;
  private readonly billing: Billing;

  constructor(
    private readonly store: LedgerStore,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {
    this.ledger = new Ledger(store);
    this.notify = new Notifier(store, this.ledger);
    this.billing = new Billing(store, this.ledger, this.notify, newId);
    this.coverage = new CoverageFlow(store, this.ledger, this.notify, newId);
  }

  /**
   * Validate, apply and record one command atomically. Accepted commands are recorded by ID so a
   * replay is a no-op; rejections are not recorded, so a corrected retry is judged afresh.
   */
  execute(command: Command): ExecuteResult {
    try {
      return this.store.tx((): ExecuteResult => {
        if (this.store.isCommandProcessed(command.commandId)) return { kind: 'duplicate' };
        const ctx = this.context(command);
        const outcome = this.dispatch(ctx);
        this.store.markCommandProcessed(command.commandId, ctx.householdId, outcome, ctx.now);
        return { kind: outcome };
      });
    } catch (error) {
      if (error instanceof Rejection) return { kind: 'rejected', code: error.code, userMessage: error.userMessage };
      throw error;
    }
  }

  private context(command: Command): Context {
    const household = this.ledger.household(command.householdId);
    if (!household) return reject('UNKNOWN_RESOURCE', 'I don\'t recognize that household.');
    const members = this.ledger.members(command.householdId);
    const actor = members.find((m) => m.userId === command.actorId);
    if (!actor) return reject('UNAUTHORIZED_ACTOR', 'Only enrolled household members can do that.');
    return {
      command,
      householdId: household.householdId,
      groupSpaceId: household.groupSpaceId,
      householdAccountId: household.householdAccountId,
      actor,
      members,
      now: this.clock.now().toISOString(),
    };
  }

  private dispatch(ctx: Context): 'accepted' | 'duplicate' {
    const payload = ctx.command.payload;
    switch (payload.kind) {
      case 'add_bill':
        return this.addBill(ctx, payload);
      case 'approve':
        return this.approve(ctx, payload.proposalId, payload.proposalVersion);
      case 'decline':
        return this.decline(ctx, payload.proposalId, payload.proposalVersion);
      case 'correct_bill':
        return this.correctBill(ctx, payload);
      case 'get_summary':
        return this.getSummary(ctx, payload.cycleId);
      case 'request_coverage':
        return this.coverage.requestCoverage(ctx, payload.billId);
      case 'share_coverage_request':
        return this.coverage.shareCoverageRequest(ctx, payload.requestId, payload.consent);
      case 'offer_coverage':
        return this.coverage.offerCoverage(ctx, payload.requestId, payload.amountCents);
    }
  }

  // ---- add_bill -----------------------------------------------------------

  private addBill(
    ctx: Context,
    payload: Extract<Command['payload'], { kind: 'add_bill' }>,
  ): 'accepted' {
    const { amountCents, dueDate, recipientId, cycleId } = payload;
    const title = payload.title.trim();
    this.validateTerms(ctx, { title, amountCents, dueDate, recipientId });
    if (this.ledger.currentCycle(ctx.householdId) !== cycleId) {
      return reject('INVALID_CYCLE_TRANSITION', `Bills can only be added for the current cycle, not ${cycleId}.`);
    }

    this.billing.createBills(ctx, ctx.members, [{ title, amountCents, dueDate, recipientId, cycleId }]);
    return 'accepted';
  }

  private validateTerms(
    ctx: Context,
    terms: { title: string; amountCents: number; dueDate: string; recipientId: string },
  ): void {
    if (!Number.isSafeInteger(terms.amountCents) || terms.amountCents <= 0) {
      reject('INVALID_AMOUNT', 'The bill amount must be a positive amount in whole cents.');
    }
    if (terms.title === '') reject('AMBIGUOUS_ACTION', 'What is this bill for? Please give it a name.');
    if (!isRealDate(terms.dueDate)) reject('AMBIGUOUS_ACTION', 'Please give the due date as YYYY-MM-DD.');
    if (!this.ledger.recipient(ctx.householdId, terms.recipientId)) {
      reject('UNKNOWN_RESOURCE', 'I only know the configured bill recipients. Who should this bill be paid to?');
    }
  }

  // ---- approve / decline --------------------------------------------------

  /** Load a proposal the actor is entitled to act on, at the exact version they saw. */
  private actionableProposal(ctx: Context, proposalId: string, version: number): ProposalRecord {
    const proposal = this.ledger.proposal(proposalId);
    if (!proposal || proposal.householdId !== ctx.householdId) {
      return reject('UNKNOWN_RESOURCE', "I couldn't find that request.");
    }
    if (!proposal.requiredActorIds.includes(ctx.actor.userId)) {
      return reject('UNAUTHORIZED_ACTOR', 'That request is not yours to approve.');
    }
    if (proposal.version !== version || proposal.status === 'superseded') return reject('STALE_PROPOSAL', STALE_MESSAGE);
    return proposal;
  }

  private approve(ctx: Context, proposalId: string, version: number): 'accepted' | 'duplicate' {
    let proposal = this.actionableProposal(ctx, proposalId, version);
    if (proposal.status === 'declined' && proposal.purpose === 'bill_payment') {
      // Declining the outgoing payment only held it; the payer may change their mind.
      this.ledger.setProposalStatus(proposalId, 'proposed', ctx.now);
      proposal = { ...proposal, status: 'proposed' };
    }
    if (proposal.status === 'declined') return reject('STALE_PROPOSAL', 'That request was declined. Ask for a new one if you changed your mind.');
    if (proposal.status === 'failed') return reject('STALE_PROPOSAL', 'That payment failed. Please approve the latest request.');

    const alreadyApproved = this.store.approvalsFor(proposalId, version).includes(ctx.actor.userId);
    if (alreadyApproved) return 'duplicate';
    if (IN_BANK_STATUSES.includes(proposal.status)) {
      return reject('ALREADY_SUBMITTED', 'That payment has already been submitted.');
    }

    if (proposal.purpose === 'bill_payment') this.checkPayable(proposal);

    this.store.recordApproval(proposalId, version, ctx.actor.userId, ctx.now);
    const approvals = this.store.approvalsFor(proposalId, version);
    if (proposal.requiredActorIds.every((id) => approvals.includes(id)) && proposal.status === 'proposed') {
      this.ledger.setProposalStatus(proposalId, 'approved', ctx.now);
      // Persist the operation before anything is sent. The processor sends it after this commits.
      this.store.insertBankOperation(
        {
          operationId: this.newId('op'),
          householdId: ctx.householdId,
          proposalId,
          proposalVersion: version,
          fromAccountId: proposal.sourceAccountId,
          toAccountId: proposal.destinationAccountId,
          amountCents: proposal.amountCents,
          description: proposal.description,
        },
        ctx.now,
      );
    }

    const bill = this.ledger.bill(proposal.billId);
    this.notify.toGroup(
      ctx,
      `deliv:${ctx.command.commandId}:approved`,
      `${ctx.actor.displayName} approved ${formatUsd(proposal.amountCents)} for ${bill?.title ?? 'the bill'}.`,
    );
    return 'accepted';
  }

  /** An outgoing payment needs a fully funded, unpaid bill whose own reserved money covers it. */
  private checkPayable(proposal: ProposalRecord): void {
    const bill = this.ledger.bill(proposal.billId);
    if (!bill) return reject('UNKNOWN_RESOURCE', "I couldn't find that bill.");
    if (bill.status === 'paid') return reject('ALREADY_SUBMITTED', 'That bill has already been paid.');
    if (bill.status !== 'ready') {
      return reject('INSUFFICIENT_HOUSE_FUNDS', "That bill isn't fully funded yet, so it can't be paid.");
    }
    if (this.ledger.reservedFunds(bill.billId) < proposal.amountCents) {
      return reject('INSUFFICIENT_HOUSE_FUNDS', "The household account doesn't have enough funds reserved for this bill yet.");
    }
  }

  private decline(ctx: Context, proposalId: string, version: number): 'accepted' | 'duplicate' {
    const proposal = this.actionableProposal(ctx, proposalId, version);
    if (proposal.status === 'declined') return 'duplicate';
    if (IN_BANK_STATUSES.includes(proposal.status) || proposal.status === 'failed') {
      return reject('ALREADY_SUBMITTED', 'That payment has already been submitted, so it can no longer be declined.');
    }
    this.ledger.setProposalStatus(proposalId, 'declined', ctx.now);
    if (proposal.purpose === 'coverage') {
      this.coverage.reopenAfterDecline(ctx, proposal);
      this.notify.toPrivate(
        ctx,
        ctx.actor.userId,
        `deliv:${ctx.command.commandId}:declined`,
        'Okay, the coverage agreement is cancelled and nothing was transferred.',
      );
      return 'accepted';
    }
    this.notify.toPrivate(
      ctx,
      ctx.actor.userId,
      `deliv:${ctx.command.commandId}:declined`,
      `Okay, I won't collect ${formatUsd(proposal.amountCents)} from you for this bill. Nothing was charged.`,
    );
    return 'accepted';
  }

  // ---- correct_bill -------------------------------------------------------

  private correctBill(
    ctx: Context,
    payload: Extract<Command['payload'], { kind: 'correct_bill' }>,
  ): 'accepted' {
    const bill = this.ledger.bill(payload.billId);
    if (!bill || bill.householdId !== ctx.householdId) return reject('UNKNOWN_RESOURCE', "I couldn't find that bill.");
    const title = payload.title.trim();
    const { amountCents, dueDate, recipientId } = payload;
    this.validateTerms(ctx, { title, amountCents, dueDate, recipientId });

    if (bill.status === 'paid' || bill.status === 'failed') {
      return reject('ALREADY_SUBMITTED', 'That bill has already been paid or failed, so it can no longer be edited.');
    }
    if (this.ledger.confirmedTotal(bill.billId) > 0) {
      return reject('ALREADY_SUBMITTED', 'Payments have already been confirmed for that bill, so it can no longer be edited.');
    }
    if (this.ledger.billHasCredit(bill.billId)) {
      return reject('ALREADY_SUBMITTED', 'That bill includes a carried-over credit, so it can no longer be edited.');
    }
    if (this.ledger.liveBankOperationCount(bill.billId) > 0) {
      return reject('ALREADY_SUBMITTED', 'A payment for that bill is in progress, so it can\'t be edited right now.');
    }
    const proposals = this.ledger.proposalsForBill(bill.billId);
    const blocking = proposals.some(
      (p) => p.purpose !== 'contribution' && !TERMINAL_PROPOSAL_STATUSES.includes(p.status),
    );
    if (blocking) {
      return reject('ALREADY_SUBMITTED', 'A coverage or payment request is open for that bill, so it can\'t be edited.');
    }

    this.coverage.closeUnagreedRequests(ctx, bill.billId);
    // Operations that were never sent are void once the terms change.
    this.ledger.cancelPreparedOperations(bill.billId, 'cancelled: bill corrected before submission', ctx.now);

    const requests = splitEqual(amountCents, ctx.members.map((m) => m.userId));
    this.ledger.updateBillTerms(bill.billId, { title, amountCents, dueDate, recipientId });
    this.ledger.setObligations(bill.billId, requests);
    const updated: BillRecord = { ...bill, title, amountCents, dueDate, recipientId };
    const recipient = this.ledger.recipient(ctx.householdId, recipientId);

    for (const member of ctx.members) {
      const cents = requests[member.userId] ?? 0;
      const existing = proposals.find(
        (p) => p.purpose === 'contribution' && p.requiredActorIds[0] === member.userId && p.status !== 'superseded',
      );
      if (cents <= 0) {
        if (existing) this.ledger.setProposalStatus(existing.proposalId, 'superseded', ctx.now);
        continue;
      }
      if (!existing) {
        const fresh = this.notify.contributionProposal(ctx, updated, member, cents, this.newId('prop'), 1);
        this.ledger.insertProposal(fresh, ctx.now);
        this.notify.announceRequest(ctx, updated, fresh, member, recipient?.displayName ?? recipientId, true);
        continue;
      }
      const revised = this.notify.contributionProposal(ctx, updated, member, cents, existing.proposalId, existing.version + 1);
      const allocation: AllocationLine[] = revised.allocation;
      this.ledger.reviseProposal(
        existing.proposalId,
        { version: revised.version, amountCents: cents, allocation, description: revised.description },
        ctx.now,
      );
      this.notify.announceRequest(ctx, updated, revised, member, recipient?.displayName ?? recipientId, true);
    }
    return 'accepted';
  }

  // ---- get_summary --------------------------------------------------------

  private getSummary(ctx: Context, cycleId: string): 'accepted' {
    const lines: string[] = [];
    const bills = this.ledger.billsForCycle(ctx.householdId, cycleId);
    if (bills.length === 0) {
      lines.push(`No bills yet for ${cycleId}.`);
    }
    for (const bill of bills) {
      const agreed = this.ledger.obligations(bill.billId);
      const confirmed = this.ledger.confirmedByBeneficiary(bill.billId);
      lines.push(`${bill.title} (${cycleId}): ${formatUsd(bill.amountCents)} due ${bill.dueDate} — ${bill.status}.`);
      for (const member of ctx.members) {
        lines.push(
          `  ${member.displayName}: agreed ${formatUsd(agreed[member.userId] ?? 0)}, confirmed ${formatUsd(confirmed[member.userId] ?? 0)}`,
        );
      }
    }
    // Debts are personal: only the requester's own appear, and only in this private reply.
    const names = new Map(ctx.members.map((m) => [m.userId, m.displayName]));
    for (const debt of this.ledger.debtsFor(ctx.householdId, ctx.actor.userId)) {
      const other = debt.debtorId === ctx.actor.userId ? debt.creditorId : debt.debtorId;
      const direction = debt.debtorId === ctx.actor.userId ? `You owe ${names.get(other) ?? other}` : `${names.get(other) ?? other} owes you`;
      lines.push(`${direction} ${formatUsd(debt.remainingCents)} from an earlier bill.`);
    }
    for (const open of this.ledger.actionableProposals(ctx.householdId, ctx.actor.userId)) {
      lines.push(`Open request: ${open.description} (${formatUsd(open.amountCents)}). Approve with "approve ${open.proposalId} v${open.version}".`);
    }
    lines.push('All amounts are simulated sandbox money in the shared household account.');
    this.notify.toPrivate(ctx, ctx.actor.userId, `deliv:${ctx.command.commandId}:summary`, lines.join('\n'));
    return 'accepted';
  }
}
