export interface InboundMessage {
  eventId: string; messageId: string; senderId: string; spaceId: string;
  visibility: 'group' | 'private'; occurredAt: string; text?: string;
  imageUrls?: string[]; reaction?: { targetMessageId: string; emoji: string };
}
export type CommandPayload =
  | { kind: 'add_bill'; amountCents: number; title: string; dueDate: string; recipientId: string; cycleId: string }
  | { kind: 'approve'; proposalId: string; proposalVersion: number }
  | { kind: 'decline'; proposalId: string; proposalVersion: number }
  | { kind: 'request_coverage'; billId: string }
  | { kind: 'share_coverage_request'; requestId: string; consent: boolean }
  | { kind: 'offer_coverage'; requestId: string; amountCents: number }
  | { kind: 'correct_bill'; billId: string; amountCents: number; title: string; dueDate: string; recipientId: string }
  | { kind: 'get_summary'; cycleId: string };
export interface Command { commandId: string; actorId: string; householdId: string; sourceEventId: string; payload: CommandPayload }
export interface OutboundMessage {
  deliveryId: string; householdId: string;
  audience: { kind: 'group'; spaceId: string } | { kind: 'private'; userId: string };
  text: string; proposalRef?: { proposalId: string; proposalVersion: number };
}
export type DomainErrorCode = 'UNAUTHORIZED_ACTOR' | 'UNKNOWN_RESOURCE' | 'INVALID_AMOUNT' | 'AMBIGUOUS_ACTION' | 'STALE_PROPOSAL' | 'ALREADY_SUBMITTED' | 'COVERAGE_UNAVAILABLE' | 'INSUFFICIENT_HOUSE_FUNDS' | 'BANK_UNAVAILABLE' | 'BANK_OUTCOME_UNKNOWN' | 'INVALID_CYCLE_TRANSITION';
export type ExecuteResult = { kind: 'accepted' | 'duplicate' } | { kind: 'rejected'; code: DomainErrorCode; userMessage: string };
export interface HouseholdSnapshot {
  householdId: string; cycleId: string; currency: 'USD'; balanceCents: number;
  bills: Array<{ billId: string; title: string; amountCents: number; dueDate: string; status: 'draft' | 'collecting' | 'ready' | 'paid' | 'failed' }>;
  contributions: Array<{ billId: string; userId: string; agreedCents: number; confirmedCents: number; coveredForUserId?: string }>;
  debts: Array<{ debtId: string; debtorId: string; creditorId: string; originalCents: number; remainingCents: number }>;
  activity: Array<{ activityId: string; occurredAt: string; description: string; status: 'pending' | 'confirmed' | 'failed' | 'unknown' }>;
}
export interface ConversationContext {
  householdId: string; cycleId: string; openBills: Array<{ billId: string; title: string }>;
  actionableProposals: Array<{ proposalId: string; proposalVersion: number; description: string }>;
  privateCoverageRequestId?: string; targetProposal?: { proposalId: string; proposalVersion: number };
}
export interface HouseholdConfig {
  householdId: string; groupSpaceId: string; designatedPayerId: string; householdAccountId: string;
  members: Array<{ userId: string; displayName: string; providerUserId: string; bankAccountId: string }>;
  recipients: Array<{ recipientId: string; displayName: string; bankAccountId: string }>;
  demoCycles: Array<{ cycleId: string; bills: Array<{ title: string; amountCents: number; dueDate: string; recipientId: string }> }>;
}
export type ParseResult = { kind: 'command'; command: Command } | { kind: 'reply'; message: OutboundMessage } | { kind: 'ignored'; reason: string };
export interface ConversationService {
  parseInbound(message: InboundMessage): Promise<ParseResult>;
  sendMessage(message: OutboundMessage): Promise<{ providerMessageId: string }>;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
export interface FinanceService {
  execute(command: Command): Promise<ExecuteResult>; reconcile(householdId: string): Promise<void>;
  getSnapshot(householdId: string): Promise<HouseholdSnapshot>; pendingMessages(): Promise<OutboundMessage[]>;
  enqueueMessage(message: OutboundMessage): Promise<void>; recordDelivery(deliveryId: string, providerMessageId: string): Promise<void>;
  /** Optional until the Finance service wires its existing durable outbox uncertainty transition. */
  markDeliveryUncertain?(deliveryId: string): Promise<void>;
  lookupProposal(providerMessageId: string): Promise<{ proposalId: string; proposalVersion: number } | null>;
  advanceDemoCycle(householdId: string, cycleId: string): Promise<void>;
  getConversationContext(actorId: string, spaceId: string, targetMessageId?: string): Promise<ConversationContext>;
  processReminders(householdId: string): Promise<void>; bootstrapHousehold(config: HouseholdConfig): Promise<void>;
  seedDemoBanking(config: HouseholdConfig): Promise<HouseholdConfig>; claimInbound(eventId: string): Promise<boolean>;
  completeInbound(eventId: string): Promise<void>; close(): Promise<void>;
}
