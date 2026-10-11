import { privateOverage, reprice } from './budget.js';
import { checkReadiness } from './readiness.js';
import { commonWindows, effectiveAvailability, hoursNeeded, resolveGroupField } from './constraints.js';
import { formatUsd } from './money.js';
import { explainRanking, groupPreferences, rankCandidates } from './rank.js';
import { DEFAULT_TIME_ZONE, assertTimeZone, scheduleStops } from './schedule.js';
import { displayName, participantIds } from './state.js';
import type { ConstraintValues, CostItem, MemberId, TripCandidate, TripErrorCode, TripReply, TripState } from './types.js';
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

export interface PlanOptions {
  /** IANA zone the itinerary is laid out in (default America/New_York). The shared contracts carry no trip timezone yet. */
  timeZone?: string;
}

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

function buildCandidate(state: TripState, option: ResearchOption, result: ResearchResult, startMs: number, endMs: number, timeZone: string): TripCandidate {
  const ids = participantIds(state);
  const candidateId = `${state.tripId}-r${state.revision}-${option.optionId}`;
  const { itinerary, leftOut } = scheduleStops(option.stops, candidateId, startMs, endMs, timeZone);

  const shared: CostItem[] = option.costs.map((c) => ({ ...c, costId: `${option.optionId}:${c.costId}`, allocation: 'equal_shared' as const, evidenceIds: [...c.evidenceIds] }));
  const personal: CostItem[] = option.perPersonCosts.flatMap((template) =>
    ids.map((memberId: MemberId) => ({ ...template, costId: `${option.optionId}:${template.costId}:${memberId}`, allocation: 'personal' as const, memberId, evidenceIds: [...template.evidenceIds] })),
  );
  const contingencyCents = (option.suggestedContingencyPerPersonCents ?? 0) * ids.length;

  const cited = new Set([...option.evidenceIds, ...itinerary.flatMap((i) => i.evidenceIds), ...shared.flatMap((c) => c.evidenceIds), ...personal.flatMap((c) => c.evidenceIds)]);
  const tradeoffs = [...option.tradeoffs];
  for (const stop of leftOut) tradeoffs.push(`Left out "${stop.label}": ${stop.reason}.`);
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

/** Where the full plan lives. The app swaps this for the real trip-page address when it sends the message. */
export const PLAN_LINK = '{{PLAN_LINK}}';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov 14-16": the trip's first and last day in local time. */
function tripDates(c: TripCandidate, timeZone: string): string {
  const day = (iso: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric', day: 'numeric' }).formatToParts(Date.parse(iso)).map((x) => [x.type, x.value]));
    return { m: Number(p.month), d: Number(p.day) };
  };
  const s = day(c.startAt), e = day(c.endAt);
  return s.m === e.m ? `${MONTHS[s.m - 1]} ${s.d}-${e.d}` : `${MONTHS[s.m - 1]} ${s.d}-${MONTHS[e.m - 1]} ${e.d}`;
}

const clip = (text: string, max: number) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`;   // end on a whole word
};

/** Two short lines per option. The itinerary, costs and sources live on the trip page, not in the chat. */
function describeOption(c: TripCandidate, rank: number, timeZone: string): string {
  const low = Math.min(...c.perPersonTotals.map((t) => t.lowCents));
  const high = Math.max(...c.perPersonTotals.map((t) => t.highCents));
  const provisional = isProvisional(c);
  return [
    `${provisional ? 'Maybe' : `Option ${rank}`}: ${c.title}`,
    `${tripDates(c, timeZone)} · about ${provisional ? 'at least ' : ''}${formatUsd(low)}-${formatUsd(high)} each${c.tradeoffs[0] ? `\n${clip(c.tradeoffs[0], 140)}` : ''}`,
  ].join('\n');
}

/** What is in the way when nothing fits, in plain words, with ways out. No one's limit is named in the group message. */
function conflictReplies(state: TripState, excluded: readonly TripCandidate[], provisional: readonly TripCandidate[]): TripReply[] {
  const replies: TripReply[] = [];
  const kinds = new Set(excluded.flatMap((c) => c.feasibility.violations.map((v) => v.kind)));
  const region = resolveGroupField(state, 'region');
  const place = region.status === 'agreed' ? ((region.value as ConstraintValues['region']).destination ?? (region.value as ConstraintValues['region']).searchRegion) : undefined;
  const duration = resolveGroupField(state, 'duration');
  const nights = duration.status === 'agreed' ? (duration.value as ConstraintValues['duration']).nights : undefined;
  const reasons: string[] = [];
  const ideas: string[] = [];
  if (kinds.has('budget')) {
    reasons.push('the trips I found cost more than at least one of you wants to spend');
    ideas.push('raise a max a little (I\'ll quietly let whoever is closest know by how much, and I never change anyone\'s limit unless they say so)', 'make it shorter');
  }
  if (provisional.length > 0) reasons.push("a couple others looked good, but I couldn't find all their prices, so I can't tell if they fit");
  if (kinds.has('availability')) { reasons.push('some fell outside the days you\'re both free'); ideas.push('open up a few more dates'); }
  if (kinds.has('must_do')) { reasons.push("some missed a must-have"); ideas.push('relax a must-have'); }
  if (kinds.has('region') || (excluded.length === 0 && provisional.length === 0)) {
    reasons.push(excluded.length === 0 && provisional.length === 0 ? `I couldn't find anything${place ? ` around ${place}` : ''} that matched` : 'some were a longer drive than you wanted');
    ideas.push('look somewhere different or a bit farther');
  }
  const head = `Hmm, I couldn't find ${nights ? `a ${nights}-night trip` : 'a trip'}${place ? ` to ${place}` : ''} that works for both of you yet.`;
  replies.push({
    audience: { kind: 'group' },
    text: [
      head,
      reasons.length > 0 ? `Here's what's getting in the way:\n${reasons.map((r) => `• ${r}`).join('\n')}` : '',
      ideas.length > 0 ? `A few ways to fix it:\n${ideas.map((i) => `• ${i}`).join('\n')}` : '',
      `Tell me what you're up for, like "my max is $400" or "I could do 1 night", and I'll look again.`,
    ].filter(Boolean).join('\n\n'),
  });

  // The one person who would have to stretch hears the exact amount, privately.
  const cheapest = [...excluded].sort(
    (a, b) => a.feasibility.violations.filter((v) => v.kind === 'budget').length - b.feasibility.violations.filter((v) => v.kind === 'budget').length,
  )[0];
  if (cheapest) {
    for (const id of participantIds(state)) {
      const over = cheapest.feasibility.violations.find((v) => v.kind === 'budget' && v.memberId === id && v.overByCents !== undefined);
      if (over) {
        replies.push({
          audience: { kind: 'private', memberId: id },
          text: `${displayName(state, id)}, the closest one was ${cheapest.title}, and it came in about ${formatUsd(over.overByCents as number)} over your max. If you're okay stretching, just tell me your new max. If not, no worries, I'll keep looking within yours.`,
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
export async function planTrip(state: TripState, researchProvider: ResearchProvider, options: PlanOptions = {}): Promise<PlanOutcome> {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  try {
    assertTimeZone(timeZone);
  } catch {
    throw new PlanningError('NOT_READY', `I don't recognize the time zone "${timeZone}".`);
  }
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

  const built = result.options.map((o) => buildCandidate(state, o, result, startMs, endMs, timeZone));
  const ranked = rankCandidates(state, built).map((r) => r.candidate);
  const shown = ranked.slice(0, OPTIONS_SHOWN);
  const provisional = built.filter(isProvisional).slice(0, shown.length === 0 ? 2 : 1);
  const unpriced = built.filter((c) => c.feasibility.violations.length === 0 && c.feasibility.unknownEssentials.length > 0 && hasNoPrices(c));
  const excluded = built.filter((c) => !c.feasibility.feasible && !isProvisional(c) && !unpriced.includes(c));

  const replies: TripReply[] = [];
  if (shown.length > 0) {
    shown.forEach((c, i) => {
      const text = describeOption(c, i + 1, timeZone);
      replies.push({
        audience: { kind: 'group' },
        text: i === 0 ? `Good news, I found ${shown.length === 1 ? 'a trip' : 'two trips'} that fit everyone's budget!\n\n${text}` : text,
        proposalRef: { candidateId: c.candidateId, revision: state.revision },
      });
    });
    const maybe = provisional.length > 0 ? `I also found ${provisional.map((c) => c.title).join(' and ')}, but I couldn't price all of it yet, so it's on the page as a maybe.\n\n` : '';
    replies.push({
      audience: { kind: 'group' },
      text: `${maybe}The full plan with the day-by-day, costs and sources is here: ${PLAN_LINK}\n\nReply "pick ${shown.length === 1 ? '1' : '1" or "pick 2'}" when you've decided, or give a thumbs up to the one you like.`,
    });
  } else {
    replies.push(...conflictReplies(state, excluded, provisional));
  }
  if (unpriced.length > 0) {
    replies.push({
      audience: { kind: 'group' },
      text: `I also found ${unpriced.map((c) => c.title).join(', ')}, but couldn't find any prices for ${unpriced.length === 1 ? 'it' : 'them'}, so I'm not proposing ${unpriced.length === 1 ? 'it' : 'them'}.`,
    });
  }
  if (shown.length > 0 || provisional.length > 0) {
    replies.push({ audience: { kind: 'group' }, text: result.mode === 'fixture' ? 'Heads up: this is demo data, so the prices are made up.' : 'These prices are estimates from web searches, so double-check them before you book anything.' });
  }

  return { revision: state.revision, mode: result.mode, candidates: [...shown, ...provisional], excluded, replies, limitations: result.limitations };
}

/** The candidates to install: up to two feasible options, best first, plus any provisional one. */
export async function generateCandidates(state: TripState, researchProvider: ResearchProvider, options: PlanOptions = {}): Promise<TripCandidate[]> {
  return (await planTrip(state, researchProvider, options)).candidates;
}
