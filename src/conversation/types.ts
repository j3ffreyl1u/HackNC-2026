import type { ConstraintField, InboundMessage, TripConfig, TripConversationContext } from './contracts-local.js';

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

/** What Gemini (or a mock) is allowed to see. No budgets, no other members' private history. */
export interface IntentInput {
  text: string;
  occurredAt: string;
  visibility: 'group' | 'private';
  timezone: string;
  memberNames: string[];
  pendingField?: ConstraintField;
  hasActionable: boolean;
  /** Names of the options on offer to pick from, in order (public titles only). */
  options?: string[];
  /** Fields the rules already captured from this message. The model should report only OTHER things. */
  alreadyKnown?: ConstraintField[];
}

/** Untrusted model output. Always validated by `validateIntent` before use. */
export type RawIntent = unknown;

export interface IntentModel {
  interpret(input: IntentInput): Promise<RawIntent>;
}

export interface ConversationDependencies {
  trip: TripConfig;
  intentModel: IntentModel;
  messenger: Messenger;
  /**
   * Off by default. When true, a DM from a number that is NOT enrolled is let through only if it is a join-code
   * message (identity `guest:<number>`), and the parser emits a `join_trip` command for the app to validate.
   */
  joinCodes?: boolean;
  /** Injected by the app (C). Used when `parseInbound` is called without an explicit context. */
  getConversationContext(actorId: string, spaceId: string, targetMessageId?: string): Promise<TripConversationContext>;
}

export type { InboundMessage };
