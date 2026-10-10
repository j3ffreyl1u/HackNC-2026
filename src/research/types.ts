import type { CostItem, Interval, SourceEvidence } from '../planning/types.js';

/** A cost every traveler bears separately (e.g. food). The generator expands it per participant. */
export type PerPersonCostTemplate = Omit<CostItem, 'costId' | 'allocation' | 'memberId'> & { costId: string };

// What B asks of a research provider and what comes back. Providers (fixture, Gemini grounding, anything
// later) are interchangeable behind `ResearchProvider`; nothing here depends on a provider SDK.

/**
 * A request carries only what a provider needs to look things up. It deliberately has no budget, calendar or
 * message text: private limits never leave the planner, so a provider cannot log or leak them.
 */
export interface ResearchRequest {
  purpose: 'plan' | 'guide';
  /** The trip revision this research is for. Echoed in the result so stale results can be discarded. */
  revision: number;
  origin?: string;
  destination?: string;
  searchRegion?: string;
  maxTravelMinutes?: number;
  /** The group's stated interests (never "no preference"). */
  interests: string[];
  /** Dates the trip could happen on, for seasonal and closure checks. */
  window?: Interval;
  /** A guide question, for `purpose: 'guide'`. Treated as data by providers. */
  question?: string;
}

/** A stop or activity found by research. Scheduling it into days is the itinerary generator's job. */
export interface ResearchStop {
  label: string;
  location: string;
  /** Lowercase keywords that make preference and must-do matching deterministic, e.g. `hiking`, `indoor`. */
  tags: string[];
  travelMinutesFromPrevious?: number;
  hours: number;
  evidenceIds: string[];
}

/** A place or plan idea with whatever cost information could be found. Unknown prices stay unknown. */
export interface ResearchOption {
  optionId: string;
  name: string;
  region: string;
  tags: string[];
  /** Drive time from the departure city when known. Unknown is not zero. */
  driveMinutesFromOrigin?: number;
  stops: ResearchStop[];
  /** Shared cost items (`equal_shared`), unique by `costId` within the option. */
  costs: CostItem[];
  /** Costs each person pays for themselves, e.g. food. */
  perPersonCosts: PerPersonCostTemplate[];
  /** A suggested contingency per person; the group may change it. Absent means none was suggested. */
  suggestedContingencyPerPersonCents?: number;
  evidenceIds: string[];
  /** Advantages and drawbacks worth telling the group. */
  tradeoffs: string[];
}

export interface ResearchResult {
  /** `fixture` is curated offline data; `live` came from a real retrieval provider on this request. */
  mode: 'fixture' | 'live';
  revision: number;
  retrievedAt: string;
  options: ResearchOption[];
  evidence: SourceEvidence[];
  /** Things the provider could not establish, shown to the group rather than hidden. */
  limitations: string[];
  /**
   * HTML the search provider requires to be shown alongside grounded answers (Google's "search suggestions").
   * Pass to whatever renders the answer; absent for fixtures.
   */
  searchSuggestionsHtml?: string[];
}

export interface ResearchProvider {
  readonly mode: 'fixture' | 'live';
  search(request: ResearchRequest): Promise<ResearchResult>;
}

export type ResearchFailure = 'not_configured' | 'request_failed' | 'invalid_result' | 'unsourced';

/** Research could not be done. Maps to the planner's `RESEARCH_UNAVAILABLE`; never answered with fixture facts. */
export class ResearchError extends Error {
  readonly code = 'RESEARCH_UNAVAILABLE' as const;
  constructor(
    readonly reason: ResearchFailure,
    readonly userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
    this.name = 'ResearchError';
  }
}
