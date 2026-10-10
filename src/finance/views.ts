import type { ConversationContext, HouseholdSnapshot } from '../contracts/index.js';
import { formatUsd } from './accounting.js';
import type { Ledger } from './ledger.js';
import { FinanceConfigError } from './runtime.js';
import type { LedgerStore } from './store.js';

/** The actor is not an enrolled member of any household. */
export class UnknownActorError extends Error {
  constructor(actorId: string) {
    super(`unknown actor ${actorId}`);
    this.name = 'UnknownActorError';
  }
}

const ACTIVITY_LIMIT = 50;

function activityStatus(status: string): 'pending' | 'confirmed' | 'failed' | 'unknown' {
  if (status === 'confirmed') return 'confirmed';
  if (status === 'failed') return 'failed';
  if (status === 'unknown') return 'unknown';
  return 'pending'; // prepared, submitted, pending
}

/**
 * Read models. Both are derived from the ledger, never from the bank, so a poll costs no network call
 * and cannot disagree with what the engine decided.
 */
export class Views {
  constructor(
    private readonly store: LedgerStore,
    private readonly ledger: Ledger,
  ) {}

  /**
   * What the household page and group may see: agreed shares, bank-confirmed contributions by payer,
   * coverage debts and transaction statuses. No bank account IDs, provider identities, failure reasons,
   * private coverage requests or messages.
   *
   * Contribution rows are keyed by payer. A member's own row carries their agreed share and what they
   * paid for themselves; money paid for someone else (coverage or a repaid credit) is a separate row
   * with `coveredForUserId`. Summing `confirmedCents` per member gives what they actually put in.
   */
  snapshot(householdId: string): HouseholdSnapshot {
    const household = this.ledger.household(householdId);
    if (!household) throw new FinanceConfigError(`unknown household ${householdId}`);
    const members = this.ledger.members(householdId);
    const bills = this.ledger.billsForHousehold(householdId);

    const contributions: HouseholdSnapshot['contributions'] = [];
    for (const bill of bills) {
      const agreed = this.ledger.obligations(bill.billId);
      const allocations = this.ledger.allocationsForBill(bill.billId);
      for (const member of members) {
        const own = allocations
          .filter((a) => a.payerId === member.userId && a.beneficiaryId === member.userId)
          .reduce((sum, a) => sum + a.amountCents, 0);
        contributions.push({ billId: bill.billId, userId: member.userId, agreedCents: agreed[member.userId] ?? 0, confirmedCents: own });
      }
      for (const a of allocations) {
        if (a.payerId === a.beneficiaryId) continue;
        contributions.push({
          billId: bill.billId,
          userId: a.payerId,
          agreedCents: 0,
          confirmedCents: a.amountCents,
          coveredForUserId: a.beneficiaryId,
        });
      }
    }

    return {
      householdId,
      cycleId: this.ledger.currentCycle(householdId) ?? '',
      currency: 'USD',
      balanceCents: this.ledger.ledgerBalance(householdId),
      bills: bills.map((b) => ({
        billId: b.billId,
        title: b.title,
        amountCents: b.amountCents,
        dueDate: b.dueDate,
        status: b.status,
      })),
      contributions,
      debts: this.ledger.debtsForHousehold(householdId).map((d) => ({
        debtId: d.debtId,
        debtorId: d.debtorId,
        creditorId: d.creditorId,
        originalCents: d.originalCents,
        remainingCents: d.remainingCents,
      })),
      activity: this.ledger.operationActivity(householdId, ACTIVITY_LIMIT).map((a) => ({
        activityId: a.operationId,
        occurredAt: a.occurredAt,
        description: a.description,
        status: activityStatus(a.status),
      })),
    };
  }

  /**
   * What the conversation layer may know about this actor in this space: only proposals they can act on,
   * and, in a private space only, their own pending coverage question. Never balances or other people's
   * private history. `targetProposal` is the exact proposal a replied-to or reacted-to message carried
   * (possibly an older version, which the engine then rejects as stale).
   */
  conversationContext(actorId: string, spaceId: string, targetMessageId?: string): ConversationContext {
    const householdId = this.ledger.householdIdForMember(actorId);
    const household = householdId ? this.ledger.household(householdId) : null;
    if (!householdId || !household) throw new UnknownActorError(actorId);

    const isGroup = spaceId === household.groupSpaceId;
    const cycleId = this.ledger.currentCycle(householdId) ?? '';
    const openBills = this.ledger
      .billsForHousehold(householdId)
      .filter((b) => b.cycleId === cycleId && b.status !== 'paid' && b.status !== 'failed')
      .map((b) => ({ billId: b.billId, title: b.title }));

    const context: ConversationContext = {
      householdId,
      cycleId,
      openBills,
      actionableProposals: this.ledger.actionableProposals(householdId, actorId).map((p) => ({
        proposalId: p.proposalId,
        proposalVersion: p.version,
        description: `${p.description} (${formatUsd(p.amountCents)})`,
      })),
    };
    if (!isGroup) {
      const pending = this.ledger.awaitingConsentRequest(actorId);
      if (pending) context.privateCoverageRequestId = pending.requestId;
    }
    if (targetMessageId !== undefined) {
      const target = this.store.lookupProviderBinding(targetMessageId);
      if (target) context.targetProposal = target;
    }
    return context;
  }
}
