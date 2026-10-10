import { privateOverage, reprice } from './budget.js';
import { checkReadiness } from './readiness.js';
import { commonWindows, effectiveAvailability, hoursNeeded, resolveGroupField } from './constraints.js';
import { formatUsd } from './money.js';
import { explainRanking, groupPreferences, rankCandidates } from './rank.js';
import { displayName, participantIds } from './state.js';
import type { ConstraintValues, CostItem, ItineraryItem, MemberId, TripCandidate, TripErrorCode, TripReply, TripState } from './types.js';
import { describeEvidence } from '../research/evidence.js';
import type { ResearchOption, ResearchProvider, ResearchRequest, ResearchResult } from '../research/types.js';

/** Planning cannot start. Carries the planner's error code and the words to say. */
export class PlanningError extends Error {
  constructor(
    readonly code: Extract<TripErrorCode, 'NOT_READY' | 'RESEARCH_UNAVAILABLE'>,
    readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = 'PlanningError';
  }
}

/** How many feasible options to put in front of the group. */
export const OPTIONS_SHOWN = 2;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

export interface PlanOutcome {
  /** The revision this plan was built for. Compare with the current revision before saving. */
  revision: number;
  mode: 'fixture' | 'live';
  /** Up to two feasible options, best first, then at most one provisional option (blocking unknown). */
  candidates: TripCandidate[];
  /** Options that were researched but break a hard limit, kept so the conflict can be explained. */
  excluded: TripCandidate[];
  /** What to tell the group (and, privately, individuals), already worded without anyone's cap. */
  replies: TripReply[];
  limitations: string[];
}

const iso = (ms: number) => new Date(ms).toISOString();

function requestFor(state: TripState): ResearchRequest {
  const ids = participantIds(state);
  const duration = resolveGroupField(state, 'duration');
  const nights = duration.status === 'agreed' ? (duration.value as ConstraintValues['duration']).nights : 1;
  const window = commonWindows(ids.map((id) => effectiveAvailability(state, id) ?? []), hoursNeeded(nights))[0];
  const origin = resolveGroupField(state, 'origin');
  const region = resolveGroupField(state, 'region');
  const place = region.status === 'agreed' ? (region.value as ConstraintValues['region']) : {};
  return {
    purpose: 'plan',
    revision: state.revision,
    ...(origin.status === 'agreed' ? { origin: (origin.value as ConstraintValues['origin']).city } : {}),
    ...(place.destination !== undefined ? { destination: place.destination } : {}),
    ...(place.searchRegion !== undefined ? { searchRegion: place.searchRegion } : {}),
    ...(place.maxTravelMinutes !== undefined ? { maxTravelMinutes: place.maxTravelMinutes } : {}),
    interests: groupPreferences(state),
    nights,
    groupSize: ids.length,
    ...(window ? { window } : {}),
  };
}

/** Lay the stops out in order from the start of the trip. Stops that cannot fit before the end are left out, and said so. */
function schedule(option: ResearchOption, candidateId: string, startMs: number, endMs: number): { itinerary: ItineraryItem[]; leftOut: string[] } {
  const itinerary: ItineraryItem[] = [];
  const leftOut: string[] = [];
  let cursor = startMs;
  option.stops.forEach((stop, index) => {
    const begin = cursor + (stop.travelMinutesFromPrevious ?? 0) * MS_PER_MINUTE;
    const finish = begin + stop.hours * MS_PER_HOUR;
    if (finish > endMs) {
      leftOut.push(stop.label);
      return;
    }
    itinerary.push({
      itemId: `${candidateId}-${index + 1}`,
      label: stop.label,
      location: stop.location,
      startAt: iso(begin),
      endAt: iso(finish),
      ...(stop.travelMinutesFromPrevious !== undefined ? { travelMinutesFromPrevious: stop.travelMinutesFromPrevious } : {}),
      evidenceIds: [...stop.evidenceIds],
      tags: stop.tags.map((t) => t.toLowerCase()),
    });
    cursor = finish;
  });
  return { itinerary, leftOut };
}

function buildCandidate(state: TripState, option: ResearchOption, result: ResearchResult, startMs: number, endMs: number): TripCandidate {
  const ids = participantIds(state);
  const candidateId = `${state.tripId}-r${state.revision}-${option.optionId}`;
  const { itinerary, leftOut } = schedule(option, candidateId, startMs, endMs);

  const shared: CostItem[] = option.costs.map((c) => ({ ...c, costId: `${option.optionId}:${c.costId}`, allocation: 'equal_shared' as const, evidenceIds: [...c.evidenceIds] }));
  const personal: CostItem[] = option.perPersonCosts.flatMap((template) =>
    ids.map((memberId: MemberId) => ({ ...template, costId: `${option.optionId}:${template.costId}:${memberId}`, allocation: 'personal' as const, memberId, evidenceIds: [...template.evidenceIds] })),
  );
  const contingencyCents = (option.suggestedContingencyPerPersonCents ?? 0) * ids.length;

  const cited = new Set([...option.evidenceIds, ...itinerary.flatMap((i) => i.evidenceIds), ...shared.flatMap((c) => c.evidenceIds), ...personal.flatMap((c) => c.evidenceIds)]);
  const tradeoffs = [...option.tradeoffs];
  for (const stop of leftOut) tradeoffs.push(`Left out "${stop}": not enough time in these dates.`);
  const unknown = [...option.costs, ...option.perPersonCosts].filter((c) => c.priceStatus === 'unknown').map((c) => c.label);
  if (unknown.length > 0) tradeoffs.push(`Price not found: ${unknown.join(', ')}. The total is only a lower bound until it is checked.`);
  if (option.suggestedContingencyPerPersonCents === undefined) tradeoffs.push('No contingency has been set yet.');
  tradeoffs.push('Availability and current prices have not been checked.');
  if (result.mode === 'fixture') tradeoffs.push('Fixture data: dates, prices and sources are synthetic.');

  return reprice(state, {
    candidateId,
    revision: state.revision,
    title: option.name,
    startAt: iso(startMs),
    endAt: iso(endMs),
    itinerary,
    costs: [...shared, ...personal],
    contingencyCents,
    perPersonTotals: [],
    evidence: result.evidence.filter((e) => cited.has(e.evidenceId)),
    tradeoffs,
    feasibility: { feasible: false, violations: [], unknownEssentials: [] },
    dataSource: result.mode,
  });
}

/** Nothing about this option's cost was found at all: it has no price to show, only a gap. */
const hasNoPrices = (c: TripCandidate) => c.costs.every((x) => x.priceStatus === 'unknown');

/** No limit is broken so far and at least some prices are known, but an essential one is still missing. */
const isProvisional = (c: TripCandidate) => c.feasibility.violations.length === 0 && c.feasibility.unknownEssentials.length > 0 && !hasNoPrices(c);

function describeOption(c: TripCandidate, rank: number): string {
  const low = Math.min(...c.perPersonTotals.map((t) => t.lowCents));
  const high = Math.max(...c.perPersonTotals.map((t) => t.highCents));
  const provisional = isProvisional(c);
  const lines = [
    `${provisional ? 'Provisional: ' : `Option ${rank}: `}${c.title}`,
    `${c.startAt.slice(0, 10)} to ${c.endAt.slice(0, 10)}. About ${provisional ? 'at least ' : ''}${formatUsd(low)} to ${formatUsd(high)} each (estimates; the upper figure includes contingency).`,
    c.itinerary.length > 0 ? `Plan: ${c.itinerary.map((i) => i.label).join(', then ')}.` : '',
    ...c.tradeoffs,
    ...c.evidence.slice(0, 3).map((e) => `Source: ${describeEvidence(e)} ${e.url}`),
  ];
  return lines.filter(Boolean).join('\n');
}

/** Why nothing fits, and what could change, as questions rather than assumptions. No cap is named. */
function conflictReplies(state: TripState, excluded: readonly TripCandidate[], provisional: readonly TripCandidate[]): TripReply[] {
  const replies: TripReply[] = [];
  const kinds = new Set(excluded.flatMap((c) => c.feasibility.violations.map((v) => v.kind)));
  const lines = ["I couldn't find an option that fits everyone's limits, so I'm not proposing one."];
  if (kinds.has('budget')) lines.push('Every option I found was over at least one person\'s maximum.');
  if (kinds.has('availability')) lines.push('Some options fall outside everyone\'s available dates.');
  if (kinds.has('must_do')) lines.push("Some options don't cover a must-have.");
  if (kinds.has('region')) lines.push('Some options are a longer drive than you wanted.');
  if (provisional.length > 0) lines.push('Others have prices I could not find yet, so I can\'t say whether they fit.');
  if (excluded.length === 0 && provisional.length === 0) lines.push('Nothing matched the place and drive limit you gave me.');
  const asks: string[] = [];
  if (kinds.has('budget')) asks.push('a shorter or cheaper trip');
  if (kinds.has('availability')) asks.push('more dates');
  if (kinds.has('region') || excluded.length === 0) asks.push('a wider search area or a longer drive');
  if (asks.length > 0) lines.push(`Would any of you be open to ${asks.join(', ')}? I won't change anyone's limits unless they say so.`);
  replies.push({ audience: { kind: 'group' }, text: lines.join(' ') });

  // The one person who would have to stretch hears the exact amount, privately.
  const cheapest = [...excluded].sort(
    (a, b) => a.feasibility.violations.filter((v) => v.kind === 'budget').length - b.feasibility.violations.filter((v) => v.kind === 'budget').length,
  )[0];
  if (cheapest) {
    for (const id of participantIds(state)) {
      const note = privateOverage(cheapest.feasibility, id);
      if (note) {
        replies.push({
          audience: { kind: 'private', memberId: id },
          text: `${displayName(state, id)}, the closest option was ${cheapest.title}. ${note} Only if you want to, tell me a higher maximum; otherwise I'll keep looking within your current one.`,
        });
      }
    }
  }
  return replies;
}

/**
 * Research the trip and turn what comes back into candidates. Hard limits filter: only options that fit every
 * person's cap, dates, must-dos and drive limit are proposed, and an option with an unknown essential price is
 * shown only as provisional. If nothing fits, the outcome explains the conflict and asks, privately where it
 * involves a cap, whether a limit may change. Fixture or live is carried on every candidate; a research
 * failure throws and is never answered with fixture facts.
 */
export async function planTrip(state: TripState, researchProvider: ResearchProvider): Promise<PlanOutcome> {
  if (!checkReadiness(state).ready) {
    throw new PlanningError('NOT_READY', "I can't plan yet: some details are missing or don't agree.");
  }
  const request = requestFor(state);
  if (!request.window) throw new PlanningError('NOT_READY', "I can't find dates that work for everyone yet.");

  const result = await researchProvider.search(request);
  if (result.revision !== state.revision) {
    throw new PlanningError('RESEARCH_UNAVAILABLE', 'The research came back for a different version of the plan, so I discarded it.');
  }

  const duration = resolveGroupField(state, 'duration');
  const nights = duration.status === 'agreed' ? (duration.value as ConstraintValues['duration']).nights : 1;
  const startMs = Date.parse(request.window.startAt);
  const endMs = startMs + nights * 24 * MS_PER_HOUR;

  const built = result.options.map((o) => buildCandidate(state, o, result, startMs, endMs));
  const ranked = rankCandidates(state, built).map((r) => r.candidate);
  const shown = ranked.slice(0, OPTIONS_SHOWN);
  const provisional = built.filter(isProvisional).slice(0, shown.length === 0 ? 2 : 1);
  const unpriced = built.filter((c) => c.feasibility.violations.length === 0 && c.feasibility.unknownEssentials.length > 0 && hasNoPrices(c));
  const excluded = built.filter((c) => !c.feasibility.feasible && !isProvisional(c) && !unpriced.includes(c));

  const replies: TripReply[] = [];
  if (shown.length > 0) {
    const intro = explainRanking(rankCandidates(state, shown)).join(' ');
    shown.forEach((c, i) => {
      const text = describeOption(c, i + 1);
      replies.push({
        audience: { kind: 'group' },
        text: i === 0 ? `Here are ${shown.length === 1 ? 'an option' : 'two options'} for revision ${state.revision}. ${intro}\n\n${text}` : text,
        proposalRef: { candidateId: c.candidateId, revision: state.revision },
      });
    });
    for (const c of provisional) {
      replies.push({ audience: { kind: 'group' }, text: describeOption(c, 0), proposalRef: { candidateId: c.candidateId, revision: state.revision } });
    }
  } else {
    replies.push(...conflictReplies(state, excluded, provisional));
    for (const c of provisional) replies.push({ audience: { kind: 'group' }, text: describeOption(c, 0) });
  }
  if (unpriced.length > 0) {
    replies.push({
      audience: { kind: 'group' },
      text: `I also found ${unpriced.map((c) => c.title).join(', ')}, but couldn't find any prices for ${unpriced.length === 1 ? 'it' : 'them'}, so I'm not proposing ${unpriced.length === 1 ? 'it' : 'them'}.`,
    });
  }
  if (result.limitations.length > 0) replies.push({ audience: { kind: 'group' }, text: `Keep in mind: ${result.limitations.join(' ')}` });

  return { revision: state.revision, mode: result.mode, candidates: [...shown, ...provisional], excluded, replies, limitations: result.limitations };
}

/** The candidates to install: up to two feasible options, best first, plus any provisional one. */
export async function generateCandidates(state: TripState, researchProvider: ResearchProvider): Promise<TripCandidate[]> {
  return (await planTrip(state, researchProvider)).candidates;
}
