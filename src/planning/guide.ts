import { allocateCosts } from './budget.js';
import { effectiveBudget, resolveGroupField } from './constraints.js';
import { formatUsd, sumCents } from './money.js';
import { groupPreferences } from './rank.js';
import { participantIds } from './state.js';
import type { ConstraintValues, CostItem, SourceEvidence, TripCandidate, TripState } from './types.js';
import { describeEvidence, sanitizeRetrievedText } from '../research/evidence.js';
import type { ResearchOption, ResearchProvider, ResearchRequest } from '../research/types.js';

export interface GuideAnswer {
  text: string;
  /** Exactly the sources the answer rests on, with their links. */
  evidence: SourceEvidence[];
  /** `none` when no research result backs the answer. */
  mode: 'fixture' | 'live' | 'none';
}

export interface GuideOptions {
  /** The current time, used to find the next stop in the plan. */
  now?: string;
  /** What is left in the shared trip fund, read from the bank. Only changes what the answer says, never what it finds. */
  fund?: { remainingDollars: number };
}

const MAX_QUESTION = 300;
const MAX_ALTERNATIVES = 3;

/** The plan the question is about: the one up for approval or approved. */
function contextCandidate(state: TripState): TripCandidate | undefined {
  if (state.selectedCandidateId === undefined) return undefined;
  return state.candidates.find((c) => c.candidateId === state.selectedCandidateId && c.revision === state.revision);
}

function nextStop(candidate: TripCandidate | undefined, now: string | undefined) {
  if (!candidate || now === undefined) return undefined;
  const at = Date.parse(now);
  return candidate.itinerary.find((i) => Date.parse(i.endAt) > at);
}

/** Does this researched option plausibly belong to the trip's place and drive limit? */
function nearTrip(state: TripState, option: ResearchOption): boolean {
  const region = resolveGroupField(state, 'region');
  if (region.status !== 'agreed') return true;
  const r = region.value as ConstraintValues['region'];
  if (r.maxTravelMinutes !== undefined && option.driveMinutesFromOrigin !== undefined && option.driveMinutesFromOrigin > r.maxTravelMinutes) return false;
  const place = `${option.name} ${option.region} ${option.stops.map((s) => s.location).join(' ')}`.toLowerCase();
  if (r.destination !== undefined) return place.includes(r.destination.toLowerCase());
  if (r.searchRegion !== undefined) return option.region.toLowerCase().includes(r.searchRegion.toLowerCase());
  return true;
}

interface Effect {
  option: ResearchOption;
  lowCents: number;
  highCents: number;
  unknown: string[];
  /** True when adding it on top of the plan keeps every person within their own cap. Undefined: can't tell. */
  fits: boolean | undefined;
  /** The most of the option's shared cost that would come out of a shared fund. Personal costs never do. */
  sharedHighCents: number;
}

/** What adding this option costs each person, checked against that person's remaining room under their cap. */
function effectOf(state: TripState, candidate: TripCandidate | undefined, option: ResearchOption): Effect {
  const ids = participantIds(state);
  const costs: CostItem[] = [
    ...option.costs.map((c) => ({ ...c, costId: `g:${c.costId}`, allocation: 'equal_shared' as const })),
    ...option.perPersonCosts.flatMap((t) => ids.map((memberId) => ({ ...t, costId: `g:${t.costId}:${memberId}`, allocation: 'personal' as const, memberId }))),
  ];
  const extra = allocateCosts(ids, costs, 0);
  // No cost information at all is unknown, never free.
  const unpriced = costs.length === 0 ? ['no price found'] : [];
  const base = candidate ? allocateCosts(ids, candidate.costs, candidate.contingencyCents).perPersonTotals : ids.map((memberId) => ({ memberId, lowCents: 0, highCents: 0 }));
  let fits: boolean | undefined = true;
  for (const add of extra.perPersonTotals) {
    const cap = effectiveBudget(state, add.memberId);
    const spent = base.find((b) => b.memberId === add.memberId)?.highCents ?? 0;
    if (cap === undefined) fits = undefined;
    else if (spent + add.highCents > cap) {
      fits = false;
      break;
    }
  }
  if ((extra.unknownEssentials.length > 0 || unpriced.length > 0) && fits !== false) fits = undefined;
  return {
    option,
    lowCents: Math.min(...extra.perPersonTotals.map((t) => t.lowCents)),
    highCents: Math.max(...extra.perPersonTotals.map((t) => t.highCents)),
    unknown: [...extra.unknownEssentials, ...unpriced],
    fits,
    sharedHighCents: sumCents(costs.filter((c) => c.allocation === 'equal_shared' && c.priceStatus !== 'unknown').map((c) => c.highCents)),
  };
}

function describeAlternative(effect: Effect, evidence: ReadonlyMap<string, SourceEvidence>, fund?: GuideOptions['fund']): string {
  const { option } = effect;
  const places = [...new Set(option.stops.map((s) => s.location))].join(', ');
  const lines = [`• ${option.name}${places ? ` (${places})` : ''}`];
  if (effect.unknown.length > 0) {
    lines.push('  Price not found, so I can\'t say whether it fits your limits.');
  } else {
    lines.push(`  Adds about ${formatUsd(effect.lowCents)} to ${formatUsd(effect.highCents)} each (estimate, on top of the plan). ${effect.fits === undefined ? "I can't confirm it fits everyone's limits." : "Fits within everyone's limits."}`);
  }
  if (fund !== undefined && Number.isFinite(fund.remainingDollars) && effect.unknown.length === 0 && effect.sharedHighCents > 0) {
    const left = Math.max(0, Math.floor(fund.remainingDollars));
    lines.push(
      effect.sharedHighCents <= left * 100
        ? `  Uses about ${formatUsd(effect.sharedHighCents)} of the shared costs, covered by the fund ($${left} left in the trip fund).`
        : `  That is more than the $${left} left in the trip fund, so the group would need to add to it.`,
    );
  }
  for (const t of option.tradeoffs) lines.push(`  ${t}`);
  const cited = [...new Set([...option.evidenceIds, ...option.stops.flatMap((s) => s.evidenceIds)])].map((id) => evidence.get(id)).filter((e): e is SourceEvidence => e !== undefined);
  const community = cited.filter((e) => e.kind === 'community').length;
  if (community > 1) lines.push('  These are separate individual reports and may not agree:');
  // Retrieved text is cleaned again here, whatever the provider did, before it reaches a chat message.
  for (const e of cited) lines.push(`  - ${sanitizeRetrievedText(describeEvidence(e), 700)} ${e.url}`);
  return lines.join('\n');
}

/**
 * Answer a question about the trip, relative to the plan, the dates, the place and everyone's limits. The
 * answer is built from retrieved, cited sources: nothing generic, and nothing without a link. It never changes
 * the plan; an alternative that would need a change is described as one that everyone must accept. Alternatives
 * that would put anyone over their cap are left out (without saying who), and unknown prices stay unknown.
 * Throws `ResearchError` if research is unavailable; it never answers from fixture facts in live mode.
 */
export async function answerGuideQuestion(
  state: TripState,
  question: string,
  researchProvider: ResearchProvider,
  options: GuideOptions = {},
): Promise<GuideAnswer> {
  const asked = sanitizeRetrievedText(question, MAX_QUESTION);
  if (asked === '') return { text: 'What would you like to know about the trip?', evidence: [], mode: 'none' };

  const candidate = contextCandidate(state);
  const next = nextStop(candidate, options.now);
  const region = resolveGroupField(state, 'region');
  const place = region.status === 'agreed' ? (region.value as ConstraintValues['region']) : {};
  const request: ResearchRequest = {
    purpose: 'guide',
    revision: state.revision,
    question: asked,
    interests: groupPreferences(state),
    ...(place.destination !== undefined ? { destination: place.destination } : {}),
    ...(place.searchRegion !== undefined ? { searchRegion: place.searchRegion } : {}),
    ...(place.maxTravelMinutes !== undefined ? { maxTravelMinutes: place.maxTravelMinutes } : {}),
    ...(candidate ? { window: { startAt: candidate.startAt, endAt: candidate.endAt } } : {}),
  };
  const result = await researchProvider.search(request);

  const relevant = result.options.filter((o) => nearTrip(state, o));
  const effects = relevant.map((o) => effectOf(state, candidate, o));
  const affordable = effects.filter((e) => e.fits !== false);
  const overCap = effects.length - affordable.length;
  const shown = affordable.slice(0, MAX_ALTERNATIVES);

  if (shown.length === 0) {
    const reasons = overCap > 0 ? ` ${overCap === 1 ? 'One option I found would' : `${overCap} options I found would`} put at least one person over their limit, so I left ${overCap === 1 ? 'it' : 'them'} out.` : '';
    return {
      text: `I couldn't find a sourced answer to that for your trip.${reasons} ${result.limitations.join(' ')}`.trim(),
      evidence: [],
      mode: result.mode,
    };
  }

  const byId = new Map(result.evidence.map((e) => [e.evidenceId, e]));
  const cited = new Set(shown.flatMap((e) => [...e.option.evidenceIds, ...e.option.stops.flatMap((s) => s.evidenceIds)]));
  const evidence = result.evidence.filter((e) => cited.has(e.evidenceId));

  const planWords = !candidate
    ? 'your trip so far (no plan has been chosen yet)'
    : state.status === 'approved'
      ? `your approved plan, ${candidate.title}`
      : `the plan up for approval, ${candidate.title}`;
  const where = next ? ` Your next stop is "${next.label}" in ${next.location}.` : '';
  const lines = [`Based on ${planWords}, here is what I found for "${asked}".${where}`, ...shown.map((e) => describeAlternative(e, byId, options.fund))];
  if (overCap > 0) lines.push(`${overCap === 1 ? 'One other option' : `${overCap} other options`} would put at least one person over their limit, so I left ${overCap === 1 ? 'it' : 'them'} out.`);
  lines.push(
    candidate
      ? "This doesn't change your plan. Swapping something in would be a change that everyone has to accept again."
      : "Nothing here is part of a plan yet.",
  );
  lines.push(...result.limitations);
  return { text: lines.join('\n'), evidence, mode: result.mode };
}
