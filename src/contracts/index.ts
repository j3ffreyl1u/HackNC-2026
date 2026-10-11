/** Shared, provider-neutral contracts for the group trip planner. IDs are opaque strings. */
import type { PendingConfirmation } from './conversation.js';
export type {
  DateWindow, ConstraintValue, PendingConfirmation, SendResult, TripMember, TripConfig,
  ActionableItem, TripConversationContext,
  ConstraintUpdate as ChatConstraintUpdate,
  TripAction as ChatTripAction,
  TripCommand as ChatTripCommand,
  ParseResult as ChatParseResult,
  ConversationService as ChatConversationService,
  ChatMode as ChatTopology,
} from './conversation.js';
import type { ConstraintValue as SharedConstraintValue } from './conversation.js';
export type ISODateTime = string;
export type MemberId = string;
export type TripId = string;

export interface InboundMessage {
  eventId: string;
  messageId: string;
  senderId: MemberId;
  spaceId: string;
  visibility: 'group' | 'private';
  occurredAt: ISODateTime;
  text?: string;
  reaction?: { targetMessageId: string; emoji: string };
}

export interface AvailabilityWindow {
  startAt: ISODateTime;
  endAt: ISODateTime;
  timeZone: string;
}

export interface StoredConstraintValueByField {
  budget: number;
  availability: AvailabilityWindow[];
  preferences: string[];
  must_dos: string[];
  transport: { mode: 'road_trip' | 'plane'; hasVehicle: boolean; notes?: string };
  region: { label: string; maxTravelMinutes?: number };
  duration: { nights: number };
  origin: { city: string; region: string; timeZone: string };
}

export type ConstraintField = keyof StoredConstraintValueByField;

/** Canonical command values. Parsed region/transport metadata lives beside value. */
export interface ConstraintValueByField {
  budget: number;
  availability: AvailabilityWindow[];
  preferences: string[];
  must_dos: string[];
  transport: string;
  region: string;
  duration: number;
  origin: string;
}
/** Storage format retained for existing SQLite records; command values below are flat. */
export type StoredConstraintUpdate = {
  [Field in ConstraintField]: {
    memberId: MemberId;
    field: Field;
    value: StoredConstraintValueByField[Field];
    sourceMessageId: string;
    certainty: 'tentative' | 'confirmed';
  }
}[ConstraintField];

export type ConstraintUpdate = (
  | { field: 'budget'; value: number }
  | { field: 'availability'; value: AvailabilityWindow[] }
  | { field: 'preferences' | 'must_dos'; value: string[] }
  | { field: 'region'; value: string; maxTravelMinutes?: number }
  | { field: 'transport'; value: string; vehicleAvailable?: boolean }
  | { field: 'origin'; value: string }
  | { field: 'duration'; value: number }
) & { memberId: MemberId; sourceMessageId: string; certainty: 'tentative' | 'confirmed' };

export type TripAction =
  | { kind: 'update_constraint'; update: ConstraintUpdate }
  | { kind: 'request_plans' }
  | { kind: 'select_candidate'; candidateId: string; revision: number }
  | { kind: 'accept_candidate'; candidateId: string; revision: number }
  /** Takes back this person's own yes to the plan that is up for approval (or approved). */
  | { kind: 'withdraw_acceptance' }
  | { kind: 'ask_guide'; question: string }
  | { kind: 'confirm_cost'; candidateId: string; revision: number; costId: string; lowCents: number; highCents: number; sourceMessageId: string }
  | { kind: 'confirm_stop'; candidateId: string; revision: number; item: ItineraryItem; sourceMessageId: string }
  | { kind: 'request_funding'; topic?: 'status' | 'remind' | 'wrap_up' }
  | { kind: 'log_purchase'; category: string; what: string; dollars?: number; shared?: boolean }
  | { kind: 'relay'; to: string; mode: 'ask' | 'tell' | 'request' | 'invite'; text: string; field?: string };

export interface TripCommand {
  commandId: string;
  eventId: string;
  actorId: MemberId;
  tripId: TripId;
  action: TripAction;
}

export interface SourceEvidence {
  evidenceId: string;
  url: string;
  title: string;
  retrievedAt: ISODateTime;
  publishedAt?: ISODateTime;
  kind: 'official' | 'community' | 'estimate' | 'web';
  claim: string;
  uncertainty?: string;
}

export interface CostItem {
  costId: string;
  category: 'accommodation' | 'transport' | 'food' | 'activity' | 'taxes_fees' | 'other';
  label: string;
  lowCents: number;
  highCents: number;
  allocation: 'equal_shared' | 'personal';
  memberId?: MemberId;
  evidenceIds: string[];
  priceStatus: 'verified' | 'estimate' | 'unknown';
  essential?: boolean;
}

export interface ItineraryItem {
  itemId: string;
  location: string;
  startAt: ISODateTime;
  endAt: ISODateTime;
  travelMinutesEstimate?: number;
  evidenceIds: string[];
  notes?: string;
  tags?: string[];
  label?: string;
}

export interface PersonCostTotal {
  memberId: MemberId;
  lowCents: number;
  highCents: number;
}

export interface FeasibilityResult {
  feasible: boolean;
  violatedConstraints: Array<{ memberId?: MemberId; constraint: string; explanation: string }>;
  unknownEssentials: string[];
}

export interface TripCandidate {
  itineraryConfirmed?: boolean;
  dataSource?: 'fixture' | 'live';
  candidateId: string;
  revision: number;
  title: string;
  startAt: ISODateTime;
  endAt: ISODateTime;
  itinerary: ItineraryItem[];
  costs: CostItem[];
  contingencyCents: number;
  perPersonTotals: PersonCostTotal[];
  evidence: SourceEvidence[];
  tradeoffs: string[];
  feasibility: FeasibilityResult;
}

export type MemberConstraintRecord = {
  [Field in ConstraintField]: {
    memberId: MemberId;
    field: Field;
    value: StoredConstraintValueByField[Field];
    sourceMessageId: string;
    certainty: 'tentative' | 'confirmed';
    updatedAt: ISODateTime;
  }
}[ConstraintField];

export type GroupConstraintRecord = {
  [Field in 'origin' | 'region' | 'duration' | 'transport']: {
    memberId: MemberId;
    field: Field;
    value: StoredConstraintValueByField[Field];
    sourceMessageId: string;
    certainty: 'tentative' | 'confirmed';
  }
}['origin' | 'region' | 'duration' | 'transport'];

export interface Acceptance {
  actorId: MemberId;
  candidateId: string;
  revision: number;
  acceptedAt: ISODateTime;
}

export interface PendingQuestion {
  questionId: string;
  audience: 'group' | 'private';
  memberId?: MemberId;
  field?: ConstraintField;
  text: string;
  askedAt: ISODateTime;
}

export interface TripState {
  /** Internal warning keys by approved revision; never part of the public snapshot. */
  /** What the bot passed between people at their request (newest last), so it can answer "did you tell Mason?". */
  relayLog?: Array<{ fromId: MemberId; toId: MemberId; kind: 'ask' | 'tell' | 'request' | 'invite'; text: string; at: string }>;
  fundingNoticeKeys?: Record<string, string[]>;
  /** Bank purchases the buyer was asked about ("was this for the trip?"), by purchase id. Internal; never part of the public snapshot. */
  purchaseChecks?: Record<string, { memberId: MemberId; status: 'asked' | 'trip' | 'personal'; askedAt: string; dollars: number; category?: string }>;
  pendingConfirmations?: Record<MemberId, PendingConfirmation>;
  costConfirmations?: Array<{ actorId: MemberId; candidateId: string; costId: string; revision: number; sourceMessageId: string; confirmedAt: string }>;
  itineraryConfirmations?: Array<{ actorId: MemberId; candidateId: string; itemId: string; revision: number; sourceMessageId: string; confirmedAt: string }>;
  roster?: Array<{ memberId: MemberId; displayName: string; consented: boolean }>;
  timeZone?: string;
  tripId: TripId;
  revision: number;
  status: 'gathering' | 'researching' | 'proposed' | 'awaiting_acceptance' | 'approved';
  memberConstraints: MemberConstraintRecord[];
  groupConstraints: GroupConstraintRecord[];
  candidates: TripCandidate[];
  selectedCandidateId?: string;
  acceptances: Acceptance[];
  pendingQuestions: PendingQuestion[];
  fundingStatus: 'disabled' | 'tracking' | 'settled' | 'requesting' | 'partially_funded' | 'funded' | 'unknown' | 'failed';
}

export interface ReadinessResult {
  ready: boolean;
  missing: string[];
  conflicts: string[];
  questions: Array<{ audience: 'group' | 'private'; memberId?: MemberId; text: string }>;
}

export interface OutboundMessage {
  deliveryId: string;
  audience: { kind: 'group'; spaceId: string } | { kind: 'private'; memberId: MemberId };
  text: string;
  proposalRef?: { candidateId: string; revision: number; kind?: 'select' | 'accept' };
}

export interface ActionablePlan {
  candidateId: string;
  revision: number;
  title: string;
  actions: Array<'pick' | 'accept'>;
}

export interface ProposalReference {
  kind?: 'select' | 'accept';
  candidateId: string;
  revision: number;
}

export type ParseResult =
  | { kind: 'command'; command: TripCommand }
  | { kind: 'commands'; commands: TripCommand[]; clarificationQuestion?: string; acknowledgement?: string; expects?: PendingConfirmation }
  | { kind: 'reply'; message: OutboundMessage; expects?: PendingConfirmation }
  | { kind: 'ignored'; reason: string };

export interface ConversationContext {
  pendingConfirmation?: PendingConfirmation;
  tripId: TripId;
  revision: number;
  status: TripState['status'];
  actionable: ActionablePlan[];
  targetProposal?: ProposalReference;
  pendingQuestion?: { questionId: string; field: ConstraintField };
  /** The shared basics this actor was asked to sign off on; a bare "yes" records them as theirs. */
  confirmBasics?: SharedConstraintValue[];
  openFields?: ConstraintField[];
  others?: Array<{ memberId: string; name: string; shared: string[]; missing: string[] }>;
  /** What this person still owes and the next question to ask them (for "what else do you need from me?"). */
  stillNeeded?: { items: string[]; question?: string };
  relays?: Array<{ withName: string; byMe: boolean; kind: 'ask' | 'tell' | 'request' | 'invite' | 'answer'; text: string }>;
  approval?: { title: string; inNames: string[]; waitingNames: string[]; youIn: boolean };
  /** The last few messages with this person, oldest first, so follow-ups like "the second one" or "how much was that?" make sense. */
  own?: { budgetDollars?: number; dates?: string; likes?: string[] };
  recent?: Array<{ from: 'you' | 'bot'; text: string }>;
  /** The options on offer in plain words (title and rough cost each), for answering questions about them. */
  optionFacts?: string[];
}

export interface ConversationService {
  parseInbound(message: InboundMessage, context: ConversationContext): Promise<ParseResult>;
  sendMessage(message: OutboundMessage): Promise<Array<{ providerMessageId: string }>>;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface AvailabilityProvider {
  getBusyIntervals(memberId: MemberId, from: ISODateTime, to: ISODateTime): Promise<AvailabilityWindow[]>;
}

export type DomainRejectionCode =
  | 'UNKNOWN_MEMBER'
  | 'INVALID_CONSTRAINT'
  | 'AMBIGUOUS_ACTION'
  | 'STALE_REVISION'
  | 'NOT_READY'
  | 'INFEASIBLE_PLAN'
  | 'MISSING_APPROVAL'
  | 'RESEARCH_UNAVAILABLE';

export interface ParticipantEnrollment {
  memberId: MemberId;
  displayName: string;
  providerUserId: string;
  consentedAt?: ISODateTime;
}

export interface TripEnrollment {
  mode?: 'group' | 'direct';
  tripId: TripId;
  groupSpaceId: string;
  participants: ParticipantEnrollment[];
}

export interface PublicTripSnapshot {
  nature?: { summaries: Array<{ candidateId: string; title: string; outdoorStops: Array<{ label: string; location: string }>; drivingMinutes: number; unknownLegs: number }>; comparison?: string };
  tripId: TripId;
  revision: number;
  status: TripState['status'];
  participants: Array<{ memberId: MemberId; displayName: string }>;
  selectedCandidate?: TripCandidate;
  candidates: TripCandidate[];
  acceptances: Acceptance[];
  fundingStatus: TripState['fundingStatus'];
}

export interface Repository {
  bootstrapTrip(enrollment: TripEnrollment, initialState: TripState): Promise<void>;
  getEnrollment(tripId: TripId): Promise<TripEnrollment | null>;
  loadTrip(tripId: TripId): Promise<TripState | null>;
  saveTripIfRevision(state: TripState, expectedRevision: number): Promise<boolean>;
  hasProcessedEvent(eventId: string): Promise<boolean>;
  recordEvent(eventId: string): Promise<boolean>;
  commitEvent(input: {
    eventId: string;
    state: TripState;
    expectedRevision: number;
    messages: OutboundMessage[];
  }): Promise<'committed' | 'duplicate' | 'stale'>;
  enqueueMessages(messages: OutboundMessage[]): Promise<void>;
  pendingMessages(): Promise<OutboundMessage[]>;
  recordDelivery(deliveryId: string, providerMessageIds: string[]): Promise<void>;
  lookupProposal(providerMessageId: string): Promise<ProposalReference | null>;
  getPublicSnapshot(tripId: TripId): Promise<PublicTripSnapshot | null>;
}
