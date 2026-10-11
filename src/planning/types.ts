// PROVISIONAL trip types for Worker B (planning and research).
//
// Cameron owns `src/contracts/index.ts` and has not published trip types yet. These follow the design
// document and fill the points it leaves open; each such point is marked PROPOSAL and has been sent to
// Cameron. When his types land this file is replaced by imports, and nothing else in B should need to
// change. All IDs are strings, money is integer USD cents, timestamps are ISO 8601 with an offset.

export type MemberId = string;

// ---- constraints ---------------------------------------------------------------------------------

export type ConstraintField =
  | 'budget'
  | 'availability'
  | 'preferences'
  | 'must_dos'
  | 'transport'
  | 'region'
  | 'duration'
  | 'origin';

export type Certainty = 'tentative' | 'confirmed';

export interface Interval {
  startAt: string;
  endAt: string;
}

/** The sentinel a member's preference list holds when they have none ("no preference"). */
export const NO_PREFERENCE = 'no preference';

/** PROPOSAL: typed values. The design document leaves the nested shapes to Cameron. */
export interface ConstraintValues {
  /** A hard, all-in maximum for the whole trip. A maximum is a constraint, never a promised contribution. */
  budget: { cents: number };
  availability: { intervals: Interval[] };
  /** Non-empty. `['no preference']` states that the member has none. */
  preferences: { items: string[] };
  /** Hard requirements: must-dos, accessibility and dietary needs. May be empty. */
  must_dos: { items: string[] };
  /** Group level. MVP is a road trip, so the only mode is a car; this records whether the group has one. */
  transport: { mode: 'car'; vehicleAvailable: boolean };
  /** Group level. A chosen destination, or a bounded search: a named region and/or a max travel time. */
  region: { destination?: string; searchRegion?: string; maxTravelMinutes?: number };
  /** Group level. Whole nights. */
  duration: { nights: number };
  /** Group level. Departure city. */
  origin: { city: string };
}

export type ConstraintUpdate = {
  [F in ConstraintField]: {
    memberId: MemberId;
    field: F;
    value: ConstraintValues[F];
    sourceMessageId: string;
    certainty: Certainty;
  };
}[ConstraintField];

/** An update as stored, with when it was applied and the trip revision it produced. */
export type ConstraintRecord = ConstraintUpdate & { recordedAt: string; revision: number };

/** Fields a single member owns. Nobody may change another member's. */
export const MEMBER_FIELDS: readonly ConstraintField[] = ['budget', 'availability', 'preferences', 'must_dos'];
/** Fields that belong to the whole group and only count once confirmed. */
export const GROUP_FIELDS: readonly ConstraintField[] = ['transport', 'region', 'duration', 'origin'];

// ---- evidence, costs and candidates --------------------------------------------------------------

/** PROPOSAL: `web` is added for grounded third-party pages that are neither official nor a discussion. */
export type EvidenceKind = 'official' | 'community' | 'estimate' | 'web';

export interface SourceEvidence {
  evidenceId: string;
  url: string;
  title: string;
  retrievedAt: string;
  publishedAt?: string;
  kind: EvidenceKind;
  claim: string;
  uncertainty?: string;
}

export type CostCategory = 'accommodation' | 'fuel_parking_tolls' | 'food' | 'activities' | 'taxes_fees' | 'other';
export type PriceStatus = 'verified' | 'estimate' | 'unknown';

export interface CostItem {
  costId: string;
  category: CostCategory;
  label: string;
  lowCents: number;
  highCents: number;
  allocation: 'equal_shared' | 'personal';
  memberId?: MemberId;
  evidenceIds: string[];
  priceStatus: PriceStatus;
  /** PROPOSAL: an essential cost whose price is unknown blocks confirmed feasibility. Defaults to true. */
  essential?: boolean;
}

export interface ItineraryItem {
  itemId: string;
  label: string;
  location: string;
  startAt: string;
  endAt: string;
  travelMinutesFromPrevious?: number;
  evidenceIds: string[];
  /** PROPOSAL: lowercase keywords that make preference and must-do matching deterministic. */
  tags: string[];
}

export interface PersonTotal {
  memberId: MemberId;
  lowCents: number;
  highCents: number;
}

export type ViolationKind = 'budget' | 'availability' | 'duration' | 'must_do' | 'region';

export interface Violation {
  kind: ViolationKind;
  memberId?: MemberId;
  /** For a budget violation: cents over the member's cap. Private to that member. */
  overByCents?: number;
  detail: string;
}

export interface Feasibility {
  feasible: boolean;
  violations: Violation[];
  /** Essential costs with no usable price. While any exist, affordability is unverified, not proven. */
  unknownEssentials: string[];
}

export interface TripCandidate {
  candidateId: string;
  /** The trip revision this candidate was generated and validated against. */
  revision: number;
  title: string;
  startAt: string;
  endAt: string;
  itinerary: ItineraryItem[];
  costs: CostItem[];
  /** PROPOSAL: the TOTAL shared contingency, split equally (fixture: 3,000 = 1,000 each). */
  contingencyCents: number;
  perPersonTotals: PersonTotal[];
  evidence: SourceEvidence[];
  tradeoffs: string[];
  feasibility: Feasibility;
  /** PROPOSAL: makes "all mock-mode dates, costs and sources are fixtures" visible on the data itself. */
  dataSource: 'fixture' | 'live';
}

// ---- state ---------------------------------------------------------------------------------------

export type TripStatus = 'gathering' | 'researching' | 'proposed' | 'awaiting_acceptance' | 'approved';
export type FundingStatus = 'disabled' | 'tracking' | 'settled' | 'requesting' | 'partially_funded' | 'funded' | 'unknown' | 'failed';

/** PROPOSAL: the design document's state omits the roster and consent record it relies on. */
export interface RosterMember {
  memberId: MemberId;
  displayName: string;
  consented: boolean;
}

export interface Acceptance {
  memberId: MemberId;
  candidateId: string;
  revision: number;
  messageId?: string;
}

export interface PendingQuestion {
  questionId: string;
  /** What the question is about, e.g. `budget:alex` or `dates`. Used to avoid asking the same thing twice. */
  key: string;
  /** The constraint a reply to this question would set. Absent for questions about who is in the trip. */
  field?: ConstraintField;
  audience: { kind: 'group' } | { kind: 'private'; memberId: MemberId };
  text: string;
  askedAt: string;
}

export interface TripState {
  tripId: string;
  revision: number;
  status: TripStatus;
  roster: RosterMember[];
  memberConstraints: Record<MemberId, ConstraintRecord[]>;
  groupConstraints: ConstraintRecord[];
  candidates: TripCandidate[];
  selectedCandidateId?: string;
  acceptances: Acceptance[];
  pendingQuestions: PendingQuestion[];
  fundingStatus: FundingStatus;
}

// ---- readiness, commands and replies -------------------------------------------------------------

export interface ReadinessQuestion {
  audience: { kind: 'group' } | { kind: 'private'; memberId: MemberId };
  text: string;
  /** PROPOSAL: matches `PendingQuestion.key`. */
  key: string;
  /** The constraint a reply would set, so a short answer like "250" can be read against it. Absent for roster/consent questions. */
  field?: ConstraintField;
}

export interface ReadinessResult {
  ready: boolean;
  missing: string[];
  conflicts: string[];
  questions: ReadinessQuestion[];
}

export type TripAction =
  | { kind: 'update_constraint'; update: ConstraintUpdate }
  | { kind: 'request_plans' }
  | { kind: 'select_candidate'; candidateId: string; revision: number }
  | { kind: 'accept_candidate'; candidateId: string; revision: number }
  | { kind: 'ask_guide'; question: string }
  | { kind: 'request_funding'; topic?: 'status' | 'remind' | 'wrap_up' }
  | { kind: 'relay'; to: string; mode: 'ask' | 'tell' | 'request' | 'invite'; text: string; field?: string };

export interface TripCommand {
  commandId: string;
  eventId: string;
  actorId: MemberId;
  tripId: string;
  action: TripAction;
}

export interface TripReply {
  audience: { kind: 'group' } | { kind: 'private'; memberId: MemberId };
  text: string;
  proposalRef?: { candidateId: string; revision: number };
}

export type TripErrorCode =
  | 'UNKNOWN_MEMBER'
  | 'INVALID_CONSTRAINT'
  | 'AMBIGUOUS_ACTION'
  | 'STALE_REVISION'
  | 'NOT_READY'
  | 'INFEASIBLE_PLAN'
  | 'MISSING_APPROVAL'
  | 'RESEARCH_UNAVAILABLE';

export interface TripRejection {
  code: TripErrorCode;
  userMessage: string;
}

/** PROPOSAL: the design document gives `{ state, replies, researchRequested }`; a rejection needs a home. */
export interface ApplyResult {
  state: TripState;
  replies: TripReply[];
  researchRequested: boolean;
  rejection?: TripRejection;
}
