import { statedPreferences } from './constraints.js';
import { formatUsd, sumCents } from './money.js';
import { NO_PREFERENCE, type TripCandidate, type TripState } from './types.js';
import { participantIds } from './state.js';

export interface RankedCandidate {
  candidate: TripCandidate;
  /** Distinct stated preferences the itinerary covers, and those it does not. */
  matchedPreferences: string[];
  unmatchedPreferences: string[];
  /** Sum of every participant's upper total. Used only to order candidates, never to test a cap. */
  upperTotalCents: number;
  /** Driving time over the whole itinerary, from the legs whose times are known. */
  travelMinutes: number;
}

const norm = (text: string) => text.trim().toLowerCase();

/** The group's stated preferences, deduplicated, with "no preference" left out. */
export function groupPreferences(state: TripState): string[] {
  const seen = new Map<string, string>();
  for (const id of participantIds(state)) {
    for (const item of statedPreferences(state, id) ?? []) {
      if (norm(item) !== NO_PREFERENCE && !seen.has(norm(item))) seen.set(norm(item), item);
    }
  }
  return [...seen.values()];
}

function covers(candidate: TripCandidate, preference: string): boolean {
  const wanted = norm(preference);
  return candidate.itinerary.some((i) => i.tags.some((t) => norm(t) === wanted) || norm(i.label).includes(wanted));
}

export function describeCandidate(state: TripState, candidate: TripCandidate): RankedCandidate {
  const preferences = groupPreferences(state);
  return {
    candidate,
    matchedPreferences: preferences.filter((p) => covers(candidate, p)),
    unmatchedPreferences: preferences.filter((p) => !covers(candidate, p)),
    upperTotalCents: sumCents(candidate.perPersonTotals.map((t) => t.highCents)),
    travelMinutes: candidate.itinerary.reduce((n, i) => n + (i.travelMinutesFromPrevious ?? 0), 0),
  };
}

/**
 * Order the feasible candidates: more of the group's stated preferences first, then the lower upper cost, then
 * the shorter drive, then ID so the result never depends on input order. Hard constraints are filters, not
 * ranking inputs: a candidate that fails validation, or has an unknown essential price, is not ranked at all.
 * Candidates are expected to carry current totals and feasibility (see `reprice`).
 */
export function rankCandidates(state: TripState, candidates: readonly TripCandidate[]): RankedCandidate[] {
  return candidates
    .filter((c) => c.feasibility.feasible)
    .map((c) => describeCandidate(state, c))
    .sort(
      (a, b) =>
        b.matchedPreferences.length - a.matchedPreferences.length ||
        a.upperTotalCents - b.upperTotalCents ||
        a.travelMinutes - b.travelMinutes ||
        a.candidate.candidateId.localeCompare(b.candidate.candidateId),
    );
}

/** Observable tradeoffs of the first-ranked candidate against the runner-up. No scores or percentages. */
export function explainRanking(ranked: readonly RankedCandidate[]): string[] {
  if (ranked.length === 0) return [];
  const [first, second] = ranked;
  const lines = [`${first.candidate.title}: covers ${list(first.matchedPreferences)}.`];
  if (first.unmatchedPreferences.length > 0) lines.push(`It does not cover ${list(first.unmatchedPreferences)}.`);
  if (second) {
    const gap = second.upperTotalCents - first.upperTotalCents;
    const compared: string[] = [];
    if (first.matchedPreferences.length > second.matchedPreferences.length) {
      compared.push(`covers more of what you asked for than ${second.candidate.title}`);
    } else if (gap > 0) {
      compared.push(`has a lower upper estimate than ${second.candidate.title} (${formatUsd(gap)} less across the group)`);
    } else if (first.travelMinutes < second.travelMinutes) {
      compared.push(`has less driving than ${second.candidate.title} (${second.travelMinutes - first.travelMinutes} minutes less)`);
    }
    if (compared.length > 0) lines.push(`It ${compared[0]}.`);
  }
  return lines;
}

function list(items: readonly string[]): string {
  if (items.length === 0) return 'none of the stated preferences';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
