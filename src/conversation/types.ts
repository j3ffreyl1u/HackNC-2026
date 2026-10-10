import type {
  ConversationContext,
  HouseholdConfig,
  InboundMessage,
} from '../contracts/index.js';

/** Provider-agnostic raw event, produced by a messenger before normalization. */
export interface RawProviderEvent {
  /** Provider's unique id for this event (message or reaction), if it has one. */
  eventId?: string;
  messageId: string;
  providerUserId: string;
  /** Provider space id; for DMs this is the DM space. */
  spaceId: string;
  isDirect: boolean;
  fromSelf: boolean;
  occurredAt: string;
  text?: string;
  imageUrls?: string[];
  reaction?: { targetMessageId: string; emoji: string; removed?: boolean };
}

export type MessengerAudience =
  | { kind: 'group'; spaceId: string }
  | { kind: 'private'; providerUserId: string };

/** Transport. Real: Spectrum. Local: mock. */
export interface Messenger {
  subscribe(onEvent: (event: RawProviderEvent) => Promise<void>): Promise<void>;
  send(audience: MessengerAudience, text: string): Promise<{ providerMessageId: string }>;
  stop(): Promise<void>;
}

/** What Gemini (or a mock) is allowed to see. No balances, no other users' private history. */
export interface IntentInput {
  text: string;
  occurredAt: string;
  visibility: 'group' | 'private';
  cycleId: string;
  openBills: Array<{ billId: string; title: string }>;
  recipientNames: string[];
  hasActionableProposals: boolean;
  hasPrivateCoverageQuestion: boolean;
}

/** Untrusted model output. Always validated by `validateIntent` before use. */
export type RawIntent = unknown;

export interface IntentModel {
  interpret(input: IntentInput): Promise<RawIntent>;
}

/** Optional additive field the parser can use if finance supplies it (see docs/conversation.md). */
export interface OpenCoverageRequest {
  requestId: string;
  /** Remaining amount the volunteer would fund, in cents. */
  amountCents: number;
}
export type ParserContext = ConversationContext & { openCoverageRequests?: OpenCoverageRequest[] };

export interface ConversationDependencies {
  household: HouseholdConfig;
  intentModel: IntentModel;
  messenger: Messenger;
  getConversationContext(
    actorId: string,
    spaceId: string,
    targetMessageId?: string,
  ): Promise<ParserContext>;
  /** Optional: title keyword -> recipientId (e.g. electricity -> duke-energy). */
  recipientAliases?: Record<string, string>;
}

export type { InboundMessage };
