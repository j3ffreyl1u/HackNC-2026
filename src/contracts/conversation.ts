/**
 * C-owned conversation contracts. These preserve A's published shapes.
 * The index exports chat-specific aliases where persistence contracts use different nested values.
 */
import type { AvailabilityWindow } from './index.js';

export interface InboundMessage {
  eventId: string;
  messageId: string;
  senderId: string;
  spaceId: string;
  visibility: 'group' | 'private';
  occurredAt: string;
  text?: string;
  reaction?: { targetMessageId: string; emoji: string };
}

export type ConstraintField = 'budget' | 'availability' | 'preferences' | 'must_dos' | 'transport' | 'region' | 'duration' | 'origin';

/** Inclusive calendar dates, YYYY-MM-DD, interpreted in the trip timezone. */
export interface DateWindow {
  start: string;
  end: string;
}

/** Typed value per field. Budget is a safe integer number of cents (all-in maximum, not a contribution promise). */
export type ConstraintValue =
  | { field: 'budget'; value: number }
  /** Date-only windows are accepted during migration; normalized commands use real intervals. */
  | { field: 'availability'; value: DateWindow[] | AvailabilityWindow[] }
  | { field: 'preferences'; value: string[] }
  | { field: 'must_dos'; value: string[] }
  | { field: 'transport'; value: string; vehicleAvailable?: boolean }
  | { field: 'region'; value: string; maxTravelMinutes?: number }
  | { field: 'origin'; value: string }
  | { field: 'duration'; value: number };

export type ConstraintUpdate = ConstraintValue & {
  memberId: string;
  sourceMessageId: string;
  certainty: 'tentative' | 'confirmed';
};

export type TripAction =
  | { kind: 'update_constraint'; update: ConstraintUpdate }
  | { kind: 'request_plans' }
  | { kind: 'select_candidate'; candidateId: string; revision: number }
  | { kind: 'accept_candidate'; candidateId: string; revision: number }
  /** Takes back this person's own yes to the plan that is up for approval (or approved). */
  | { kind: 'withdraw_acceptance' }
  | { kind: 'ask_guide'; question: string }
  | { kind: 'request_funding'; topic?: 'status' | 'remind' | 'wrap_up' }
  | { kind: 'log_purchase'; category: string; what: string; dollars?: number; shared?: boolean }
  | { kind: 'relay'; to: string; mode: 'ask' | 'tell' | 'request' | 'invite'; text: string; field?: string };

export interface TripCommand {
  commandId: string;
  eventId: string;
  actorId: string;
  tripId: string;
  action: TripAction;
}

export interface OutboundMessage {
  deliveryId: string;
  audience: { kind: 'group'; spaceId: string } | { kind: 'private'; memberId: string };
  text: string;
  proposalRef?: { candidateId: string; revision: number };
}

/**
 * A yes/no question we just asked this member. The app stores it (per member) and passes it back as
 * `TripConversationContext.pendingConfirmation` so a later "yes" has meaning. Clear it once answered.
 */
export type PendingConfirmation = { field: 'budget'; valueCents: number } | { field: 'availability'; windows: Array<{ start: string; end: string }> };

/**
 * - `command`: exactly one command and nothing to say.
 * - `commands`: several updates from one message, and/or updates plus a clarification (additive to the spec).
 * - `reply`: a clarification or help text, no state change.
 * - `ignored`: not for the assistant, or not allowed.
 */
export type ParseResult =
  | { kind: 'command'; command: TripCommand }
  /** `acknowledgement` is a plain "Got it": unlike `clarification` (a real question) it does not pause follow-up questions. */
  | { kind: 'commands'; commands: TripCommand[]; clarification?: OutboundMessage; acknowledgement?: OutboundMessage; expects?: PendingConfirmation }
  | { kind: 'reply'; message: OutboundMessage; expects?: PendingConfirmation }
  | { kind: 'ignored'; reason: string };

export interface SendResult {
  /** Provider id to bind reactions to. In `direct` fan-out this is the first successful delivery. */
  providerMessageId: string;
  /** Every individual delivery (direct-mode broadcast, or a single private send). */
  deliveries: Array<{ memberId: string; providerMessageId: string }>;
  /** Direct-mode broadcast only: members whose delivery failed. */
  failedMemberIds?: string[];
}

export interface TripMember {
  userId: string;
  displayName: string;
  /** Provider identity; for iMessage this is the sender's E.164 phone number. */
  providerUserId: string;
}

/**
 * Chat topology.
 * - `group`: one shared iMessage group. DMs from enrolled members are also accepted (private limits).
 * - `direct`: no group needed. Each member (or just one person) talks to the assistant one-on-one.
 *   A group-audience outbound message is delivered as an individual DM to every member.
 * Switching is a config change; the parser, privacy rules and command shapes are identical.
 */
export type ChatMode = 'group' | 'direct';

export interface TripConfig {
  tripId: string;
  mode: ChatMode;
  /** `group`: the provider space id of the enrolled group. `direct`: a logical label, never sent to the provider. */
  groupSpaceId: string;
  /** IANA timezone used for dates, e.g. America/New_York. */
  timezone: string;
  members: TripMember[];
}

export interface ActionableItem {
  /** `select`: option preference. `accept`: acceptance of an exact plan version. */
  kind: 'select' | 'accept';
  candidateId: string;
  revision: number;
  description: string;
}

/** Supplied by the app/domain layer (C, backed by B's state). Contains no private values. */
export interface TripConversationContext {
  tripId: string;
  revision: number;
  /** Items this actor can act on right now, at their current revision. */
  actionable: ActionableItem[];
  /** Resolved from the reaction's target message id by the app; undefined if it was not a proposal message. */
  targetProposal?: { kind: 'select' | 'accept'; candidateId: string; revision: number };
  /** The field this actor was last asked about, so a bare "200" or "Oct 17-19" has meaning. */
  pendingQuestion?: { field: ConstraintField };
  /** What each OTHER person has told the bot that is fine to repeat (dates, car, tastes; never a budget), so "what did Mason say?" can be answered. */
  others?: Array<{ memberId: string; name: string; shared: string[]; missing: string[] }>;
  /** What the bot passed on between this person and others at their request, so "did you tell Mason that I have a car?" can be answered. */
  relays?: Array<{ withName: string; byMe: boolean; kind: 'ask' | 'tell' | 'request' | 'invite' | 'answer'; text: string }>;
  /** What this person has told the bot about themselves, so "what's my budget?" and "what dates did I give you?" are answered (to them only). */
  own?: { budgetDollars?: number; dates?: string; likes?: string[] };
  /** The last few messages with this person, oldest first, so follow-ups like "the second one" or "how much was that?" make sense. */
  recent?: Array<{ from: 'you' | 'bot'; text: string }>;
  /** The options on offer in plain words (title and rough cost each), for answering questions about them. */
  optionFacts?: string[];
  /** Who has said "I'm in" on the picked plan, so "has Mason confirmed?" gets an exact answer. */
  approval?: { title: string; inNames: string[]; waitingNames: string[]; youIn: boolean };
  /** Where the trip stands, so "what's the status?" can be answered without guessing. */
  status?: 'gathering' | 'researching' | 'proposed' | 'awaiting_acceptance' | 'approved';
  /** Every field there is an open question about for this actor (their own and the shared one), most relevant first, so a volunteered answer to any of them is understood. */
  openFields?: ConstraintField[];
  /** The shared basics (origin, length, place, car) this actor was asked to sign off on; a bare "yes" records them as theirs. */
  confirmBasics?: ConstraintValue[];
  /** Set from the `expects` of the last reply to this member, e.g. "Is $250 your firm maximum?". */
  pendingConfirmation?: PendingConfirmation;
}

export interface ConversationService {
  parseInbound(message: InboundMessage, context?: TripConversationContext): Promise<ParseResult>;
  sendMessage(message: OutboundMessage): Promise<SendResult>;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
