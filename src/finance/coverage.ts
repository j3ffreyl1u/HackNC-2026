import { formatUsd } from './accounting.js';
import type { AllocationLine, BillRecord, CoverageRequestRecord, Ledger, ProposalRecord } from './ledger.js';
import type { IdGenerator } from './runtime.js';
import type { LedgerStore } from './store.js';
import { reject, type Context, type Notifier } from './support.js';

/** Proposal statuses that mean a transfer was sent (or may have been) and cannot be withdrawn. */
const IN_FLIGHT = ['submitted', 'pending', 'unknown'];
/** Contribution proposals nobody has paid on yet, so a coverage agreement may replace them. */
const REPLACEABLE = ['proposed', 'approved', 'declined'];

/**
 * Private, consensual coverage. A short member asks privately (`request_coverage`), separately allows
 * the household to be asked (`share_coverage_request`), a volunteer offers the full remaining share
 * (`offer_coverage`), and only then do the debtor and volunteer approve the exact terms. A debt exists
 * only after the bank confirms the volunteer's funding (see BankProcessor).
 */
export class CoverageFlow {
  constructor(
    private readonly store: LedgerStore,
    private readonly ledger: Ledger,
    private readonly notify: Notifier,
    private readonly newId: IdGenerator,
  ) {}

  /** Cents a member still owes on a bill: agreed share minus what the bank has confirmed for them. */
  remainingShare(billId: string, userId: string): number {
    const agreed = this.ledger.obligations(billId)[userId] ?? 0;
    const confirmed = this.ledger.confirmedByBeneficiary(billId)[userId] ?? 0;
    return Math.max(0, agreed - confirmed);
  }

  private liveContribution(billId: string, userId: string): ProposalRecord | null {
    const mine = this.ledger
      .proposalsForBill(billId)
      .filter((p) => p.purpose === 'contribution' && p.requiredActorIds[0] === userId && p.status !== 'superseded');
    return mine.at(-1) ?? null;
  }

  private name(ctx: Context, userId: string): string {
    return ctx.members.find((m) => m.userId === userId)?.displayName ?? userId;
  }

  private billFor(ctx: Context, billId: string): BillRecord {
    const bill = this.ledger.bill(billId);
    if (!bill || bill.householdId !== ctx.householdId) return reject('UNKNOWN_RESOURCE', "I couldn't find that bill.");
    return bill;
  }

  private requestFor(ctx: Context, requestId: string): CoverageRequestRecord {
    const request = this.ledger.coverageRequest(requestId);
    if (!request || request.householdId !== ctx.householdId) {
      return reject('UNKNOWN_RESOURCE', "I couldn't find that request.");
    }
    return request;
  }

  // ---- 1. a member privately asks for help ------------------------------------

  requestCoverage(ctx: Context, billId: string): 'accepted' | 'duplicate' {
    const bill = this.billFor(ctx, billId);
    const me = ctx.actor.userId;
    if (bill.status === 'paid' || bill.status === 'failed') {
      return reject('COVERAGE_UNAVAILABLE', 'That bill is already settled.');
    }
    const remaining = this.remainingShare(billId, me);
    if (remaining <= 0) return reject('COVERAGE_UNAVAILABLE', "You don't have anything left to pay on that bill.");

    const mine = this.ledger.activeCoverageRequests(billId).find((r) => r.debtorId === me);
    if (mine) {
      if (mine.status === 'awaiting_share_consent') return 'duplicate';
      return reject('COVERAGE_UNAVAILABLE', 'You already have a coverage request open for that bill.');
    }
    const own = this.liveContribution(billId, me);
    if (own && IN_FLIGHT.includes(own.status)) {
      return reject('ALREADY_SUBMITTED', 'Your payment for that bill is already in progress.');
    }

    const requestId = this.newId('cov');
    this.ledger.insertCoverageRequest(
      { requestId, householdId: ctx.householdId, billId, debtorId: me, amountCents: remaining, status: 'awaiting_share_consent', supersededProposalIds: [] },
      ctx.now,
    );
    // Private only: nothing is disclosed to the group until the member says so.
    this.notify.toPrivate(
      ctx,
      me,
      `deliv:${requestId}:consent`,
      `I can ask the household if someone can cover your ${formatUsd(remaining)} share of ${bill.title}. ` +
        `Nothing is shared with the group unless you agree. Reply yes to let me ask, or no to keep this private ` +
        `(request ${requestId}).`,
    );
    return 'accepted';
  }

  // ---- 2. the member decides whether the household may be asked -------------

  shareCoverageRequest(ctx: Context, requestId: string, consent: boolean): 'accepted' | 'duplicate' {
    const request = this.requestFor(ctx, requestId);
    if (request.debtorId !== ctx.actor.userId) {
      return reject('UNAUTHORIZED_ACTOR', 'That request is not yours to answer.');
    }
    if (request.status !== 'awaiting_share_consent') {
      const alreadyAnswered = consent ? ['open', 'awaiting_approvals', 'funded'] : ['closed'];
      if (alreadyAnswered.includes(request.status)) return 'duplicate';
      return reject('COVERAGE_UNAVAILABLE', 'That request is no longer waiting for your answer.');
    }
    const bill = this.billFor(ctx, request.billId);

    if (!consent) {
      this.ledger.updateCoverageRequest(requestId, { status: 'closed' }, ctx.now);
      this.notify.toPrivate(ctx, ctx.actor.userId, `deliv:${ctx.command.commandId}:kept-private`, "Okay, I won't ask the group. This stays private.");
      return 'accepted';
    }

    this.ledger.updateCoverageRequest(requestId, { status: 'open' }, ctx.now);
    const who = ctx.actor.displayName;
    this.notify.toGroup(
      ctx,
      `deliv:${requestId}:ask`,
      `${who} would like help covering ${formatUsd(request.amountCents)} of their share of ${bill.title}. ` +
        `If you can cover the full amount, reply "cover ${requestId} ${formatUsd(request.amountCents)}". ` +
        `${who} and the volunteer both approve before anything moves.`,
    );
    this.notify.toPrivate(ctx, ctx.actor.userId, `deliv:${ctx.command.commandId}:asked`, "Okay, I've asked the group. Nothing happens unless you approve the exact terms.");
    return 'accepted';
  }

  // ---- 3. a volunteer offers the full remaining share ----------------------

  offerCoverage(ctx: Context, requestId: string, amountCents: number): 'accepted' | 'duplicate' {
    const request = this.requestFor(ctx, requestId);
    const volunteer = ctx.actor;
    if (volunteer.userId === request.debtorId) {
      return reject('COVERAGE_UNAVAILABLE', "You can't cover your own share.");
    }
    if (request.status === 'awaiting_approvals') {
      if (request.volunteerId === volunteer.userId) return 'duplicate';
      return reject('COVERAGE_UNAVAILABLE', 'Another offer is already awaiting confirmation.');
    }
    if (request.status !== 'open') {
      return reject('COVERAGE_UNAVAILABLE', "That request isn't open for offers.");
    }
    const bill = this.billFor(ctx, request.billId);
    if (bill.status === 'paid' || bill.status === 'failed') {
      return reject('COVERAGE_UNAVAILABLE', 'That bill is already settled.');
    }

    const debtorRemaining = this.remainingShare(bill.billId, request.debtorId);
    if (debtorRemaining <= 0) return reject('COVERAGE_UNAVAILABLE', 'That share has already been paid.');
    if (!Number.isSafeInteger(amountCents) || amountCents !== debtorRemaining) {
      return reject('INVALID_AMOUNT', `I can only arrange coverage for the full remaining ${formatUsd(debtorRemaining)}.`);
    }

    const debtorOwn = this.liveContribution(bill.billId, request.debtorId);
    if (debtorOwn && IN_FLIGHT.includes(debtorOwn.status)) {
      return reject('COVERAGE_UNAVAILABLE', 'Their own payment is already in progress.');
    }
    const volunteerOwn = this.liveContribution(bill.billId, volunteer.userId);
    if (volunteerOwn && IN_FLIGHT.includes(volunteerOwn.status)) {
      return reject('COVERAGE_UNAVAILABLE', 'Your own payment for this bill is in progress. Try again once it is confirmed.');
    }

    // Never collect the volunteer's own share twice: replace any unpaid contribution proposals.
    const superseded: string[] = [];
    for (const own of [volunteerOwn, debtorOwn]) {
      if (own && REPLACEABLE.includes(own.status)) {
        this.ledger.cancelPreparedOperationsForProposal(own.proposalId, 'cancelled: replaced by a coverage agreement', ctx.now);
        this.ledger.setProposalStatus(own.proposalId, 'superseded', ctx.now);
        superseded.push(own.proposalId);
      }
    }

    // If the volunteer already paid their own share, only the additional amount is proposed.
    const volunteerRemaining = this.remainingShare(bill.billId, volunteer.userId);
    const allocation: AllocationLine[] = [];
    if (volunteerRemaining > 0) {
      allocation.push({ payerId: volunteer.userId, beneficiaryId: volunteer.userId, amountCents: volunteerRemaining, kind: 'own' });
    }
    allocation.push({ payerId: volunteer.userId, beneficiaryId: request.debtorId, amountCents: debtorRemaining, kind: 'coverage' });
    const total = volunteerRemaining + debtorRemaining;

    const debtorName = this.name(ctx, request.debtorId);
    const proposal: ProposalRecord = {
      proposalId: this.newId('prop'),
      householdId: ctx.householdId,
      billId: bill.billId,
      purpose: 'coverage',
      version: 1,
      status: 'proposed',
      amountCents: total,
      sourceAccountId: volunteer.bankAccountId,
      destinationAccountId: ctx.householdAccountId,
      requiredActorIds: [volunteer.userId, request.debtorId],
      allocation,
      description: `${volunteer.displayName} covers ${debtorName}'s ${formatUsd(debtorRemaining)} share of ${bill.title}`,
    };
    this.ledger.insertProposal(proposal, ctx.now);
    this.ledger.updateCoverageRequest(
      requestId,
      { status: 'awaiting_approvals', volunteerId: volunteer.userId, proposalId: proposal.proposalId, supersededProposalIds: superseded },
      ctx.now,
    );

    const own = volunteerRemaining > 0 ? ` (${formatUsd(volunteerRemaining)} for their own share plus ${formatUsd(debtorRemaining)} for ${debtorName})` : '';
    this.notify.toGroup(
      ctx,
      `deliv:${proposal.proposalId}:v1:request`,
      `Coverage agreement for ${bill.title}: ${volunteer.displayName} sends ${formatUsd(total)} to the household account${own}. ` +
        `${debtorName} then owes ${volunteer.displayName} ${formatUsd(debtorRemaining)}, adjusted in next month's requests. ` +
        `${volunteer.displayName} and ${debtorName}: react 👍 to this message or reply "approve ${proposal.proposalId} v1" to agree. ` +
        `Nothing moves until both of you approve.`,
      { proposalId: proposal.proposalId, proposalVersion: 1 },
    );
    return 'accepted';
  }

  // ---- 4. the agreement falls through ------------------------------------------

  /**
   * A coverage proposal was declined: reopen the request, undo nothing that moved (nothing did) and
   * give the replaced contribution proposals back to their owners at a new version.
   */
  reopenAfterDecline(ctx: Context, proposal: ProposalRecord): void {
    const request = this.ledger.coverageRequestForProposal(proposal.proposalId);
    if (!request) return;
    const bill = this.billFor(ctx, request.billId);
    const recipient = this.ledger.recipient(ctx.householdId, bill.recipientId);

    for (const proposalId of request.supersededProposalIds) {
      const old = this.ledger.proposal(proposalId);
      if (!old || old.status !== 'superseded') continue;
      const owner = ctx.members.find((m) => m.userId === old.requiredActorIds[0]);
      const remaining = owner ? this.remainingShare(bill.billId, owner.userId) : 0;
      if (!owner || remaining <= 0) continue;
      const revived = this.notify.contributionProposal(ctx, bill, owner, remaining, old.proposalId, old.version + 1);
      this.ledger.reviseProposal(
        old.proposalId,
        { version: revived.version, amountCents: remaining, allocation: revived.allocation, description: revived.description },
        ctx.now,
      );
      this.notify.announceRequest(ctx, bill, revived, owner, recipient?.displayName ?? bill.recipientId, true);
    }

    this.ledger.updateCoverageRequest(
      request.requestId,
      { status: 'open', volunteerId: null, proposalId: null, supersededProposalIds: [] },
      ctx.now,
    );
    const debtorName = this.name(ctx, request.debtorId);
    this.notify.toGroup(
      ctx,
      `deliv:${ctx.command.commandId}:reopened`,
      `The coverage agreement for ${bill.title} wasn't completed and nothing was transferred. ` +
        `${debtorName}'s request is open again: reply "cover ${request.requestId} ${formatUsd(request.amountCents)}" if you can help.`,
    );
  }

  /** A bill's terms changed, so requests that had not reached an agreement no longer fit. */
  closeUnagreedRequests(ctx: Context, billId: string): void {
    const bill = this.ledger.bill(billId);
    for (const request of this.ledger.activeCoverageRequests(billId)) {
      if (request.status === 'awaiting_approvals') continue; // blocked by the open proposal instead
      this.ledger.updateCoverageRequest(request.requestId, { status: 'closed' }, ctx.now);
      this.notify.toPrivate(
        ctx,
        request.debtorId,
        `deliv:${ctx.command.commandId}:closed:${request.requestId}`,
        `${bill?.title ?? 'The bill'} changed, so your coverage request was closed. Ask again if you still need help.`,
      );
    }
  }
}
