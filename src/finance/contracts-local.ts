// Temporary local declarations matching the shared contract in AGENTS.md.
// Replace with imports from `src/contracts/index.ts` once C publishes it.
// All IDs and timestamps are strings; money is integer USD cents; versions are integers.

export type CommandPayload =
  | { kind: 'add_bill'; amountCents: number; title: string; dueDate: string; recipientId: string; cycleId: string }
  | { kind: 'approve'; proposalId: string; proposalVersion: number }
  | { kind: 'decline'; proposalId: string; proposalVersion: number }
  | { kind: 'request_coverage'; billId: string }
  | { kind: 'share_coverage_request'; requestId: string; consent: boolean }
  | { kind: 'offer_coverage'; requestId: string; amountCents: number }
  | { kind: 'correct_bill'; billId: string; amountCents: number; title: string; dueDate: string; recipientId: string }
  | { kind: 'get_summary'; cycleId: string };

export interface Command {
  commandId: string;
  actorId: string;
  householdId: string;
  sourceEventId: string;
  payload: CommandPayload;
}

export interface OutboundMessage {
  deliveryId: string;
  householdId: string;
  audience: { kind: 'group'; spaceId: string } | { kind: 'private'; userId: string };
  text: string;
  proposalRef?: { proposalId: string; proposalVersion: number };
}

export type DomainErrorCode =
  | 'UNAUTHORIZED_ACTOR'
  | 'UNKNOWN_RESOURCE'
  | 'INVALID_AMOUNT'
  | 'AMBIGUOUS_ACTION'
  | 'STALE_PROPOSAL'
  | 'ALREADY_SUBMITTED'
  | 'COVERAGE_UNAVAILABLE'
  | 'INSUFFICIENT_HOUSE_FUNDS'
  | 'BANK_UNAVAILABLE'
  | 'BANK_OUTCOME_UNKNOWN'
  | 'INVALID_CYCLE_TRANSITION';

export type ExecuteResult =
  | { kind: 'accepted' | 'duplicate' }
  | { kind: 'rejected'; code: DomainErrorCode; userMessage: string };

export interface HouseholdSnapshot {
  householdId: string;
  cycleId: string;
  currency: 'USD';
  balanceCents: number;
  bills: Array<{
    billId: string;
    title: string;
    amountCents: number;
    dueDate: string;
    status: 'draft' | 'collecting' | 'ready' | 'paid' | 'failed';
  }>;
  contributions: Array<{
    billId: string;
    userId: string;
    agreedCents: number;
    confirmedCents: number;
    coveredForUserId?: string;
  }>;
  debts: Array<{
    debtId: string;
    debtorId: string;
    creditorId: string;
    originalCents: number;
    remainingCents: number;
  }>;
  activity: Array<{
    activityId: string;
    occurredAt: string;
    description: string;
    status: 'pending' | 'confirmed' | 'failed' | 'unknown';
  }>;
}

export interface ConversationContext {
  householdId: string;
  cycleId: string;
  openBills: Array<{ billId: string; title: string }>;
  actionableProposals: Array<{ proposalId: string; proposalVersion: number; description: string }>;
  privateCoverageRequestId?: string;
  targetProposal?: { proposalId: string; proposalVersion: number };
}

export interface HouseholdConfig {
  householdId: string;
  groupSpaceId: string;
  designatedPayerId: string;
  householdAccountId: string;
  members: Array<{ userId: string; displayName: string; providerUserId: string; bankAccountId: string }>;
  recipients: Array<{ recipientId: string; displayName: string; bankAccountId: string }>;
  demoCycles: Array<{
    cycleId: string;
    bills: Array<{ title: string; amountCents: number; dueDate: string; recipientId: string }>;
  }>;
}
