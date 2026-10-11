import { effectiveAvailability, effectiveBudget, effectiveMustDos, normalizeIntervals, resolveGroupField } from './constraints.js';
import { MoneyError, addCents, formatUsd, formatUsdWhole, makeRange, splitEqual, sumCents } from './money.js';
import { displayName, participantIds } from './state.js';
import type {
  ConstraintValues,
  CostItem,
  Feasibility,
  MemberId,
  PersonTotal,
  TripCandidate,
  TripState,
  Violation,
} from './types.js';

const MS_PER_HOUR = 60 * 60 * 1000;

export interface Allocation {
  perPersonTotals: PersonTotal[];
  /** Essential costs with no usable price. Their cost is NOT in the totals, which are then only a lower bound. */
  unknownEssentials: string[];
}

/** An essential cost is one the trip cannot go ahead without; costs default to essential. */
const isEssential = (cost: CostItem) => cost.essential !== false;

function checkCosts(ids: readonly MemberId[], costs: readonly CostItem[]): void {
  const seen = new Set<string>();
  for (const cost of costs) {
    if (seen.has(cost.costId)) throw new MoneyError(`cost ${cost.costId} appears twice`);
    seen.add(cost.costId);
    if (cost.priceStatus !== 'unknown') makeRange(cost.lowCents, cost.highCents);
    if (cost.allocation === 'personal') {
      if (!cost.memberId || !ids.includes(cost.memberId)) {
        throw new MoneyError(`personal cost ${cost.costId} must belong to a participant`);
      }
    } else if (cost.memberId !== undefined) {
      throw new MoneyError(`shared cost ${cost.costId} must not name a person`);
    }
  }
}

/**
 * Split a candidate's costs across the participants. Shared costs and the shared contingency are split
 * equally (remainder cents to the earliest participants, so parts sum exactly); personal costs go only to
 * their owner. The high figure includes the contingency; the low figure does not, since contingency is a
 * reserve, not an expected cost. A cost whose price is unknown is never counted as zero: it is listed in
 * `unknownEssentials` instead and left out of the sums.
 */
export function allocateCosts(
  participants: readonly MemberId[],
  costs: readonly CostItem[],
  contingencyCents: number,
): Allocation {
  if (participants.length === 0) throw new MoneyError('at least one person is required');
  checkCosts(participants, costs);

  const priced = costs.filter((c) => c.priceStatus !== 'unknown');
  const shared = priced.filter((c) => c.allocation === 'equal_shared');
  const sharedLow = splitEqual(sumCents(shared.map((c) => c.lowCents)), participants);
  // Shared costs and contingency are split together so their remainders can't both fall on the same person.
  const sharedHigh = splitEqual(addCents(sumCents(shared.map((c) => c.highCents)), contingencyCents), participants);

  const perPersonTotals = participants.map((memberId) => {
    const own = priced.filter((c) => c.allocation === 'personal' && c.memberId === memberId);
    return {
      memberId,
      lowCents: addCents(sharedLow[memberId], sumCents(own.map((c) => c.lowCents))),
      highCents: addCents(sharedHigh[memberId], sumCents(own.map((c) => c.highCents))),
    };
  });
  const unknownEssentials = costs.filter((c) => c.priceStatus === 'unknown' && isEssential(c)).map((c) => c.costId);
  return { perPersonTotals, unknownEssentials };
}

// ---- validation ---------------------------------------------------------------------------------------

function norm(text: string): string {
  return text.trim().toLowerCase();
}

/** A must-do is met when some itinerary stop is tagged with it or names it. */
function mustDoMet(candidate: TripCandidate, mustDo: string): boolean {
  const wanted = norm(mustDo);
  return candidate.itinerary.some((item) => item.tags.some((t) => norm(t) === wanted) || norm(item.label).includes(wanted));
}

/**
 * Check a candidate against the trip's current hard constraints, using freshly computed totals rather than
 * whatever the candidate claims. Hard limits are filters: the upper estimate plus contingency, per person,
 * must fit each person's all-in cap. A missing or unknown essential price makes affordability unverified,
 * so the candidate is not feasible, but it is reported as an unknown, not as a budget violation.
 */
export function validateCandidate(state: TripState, candidate: TripCandidate): Feasibility {
  const ids = participantIds(state);
  const violations: Violation[] = [];
  const { perPersonTotals, unknownEssentials } = allocateCosts(ids, candidate.costs, candidate.contingencyCents);

  // -- money: each person's own cap against their own upper total
  for (const total of perPersonTotals) {
    const cap = effectiveBudget(state, total.memberId);
    if (cap === undefined) {
      violations.push({ kind: 'budget', memberId: total.memberId, detail: "A maximum has not been given, so affordability can't be checked." });
    } else if (total.highCents > cap) {
      violations.push({
        kind: 'budget',
        memberId: total.memberId,
        overByCents: total.highCents - cap,
        detail: "The upper estimate is over this person's maximum.",
      });
    }
  }

  // -- dates: the whole trip must sit inside every participant's confirmed windows
  const start = Date.parse(candidate.startAt);
  const end = Date.parse(candidate.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    violations.push({ kind: 'availability', detail: 'The trip dates are not a valid start and end.' });
  } else {
    for (const id of ids) {
      const windows = effectiveAvailability(state, id);
      const who = displayName(state, id);
      if (windows === undefined) {
        violations.push({ kind: 'availability', memberId: id, detail: `${who} has not given usable dates.` });
      } else if (!normalizeIntervals(windows).some((w) => Date.parse(w.startAt) <= start && end <= Date.parse(w.endAt))) {
        violations.push({ kind: 'availability', memberId: id, detail: `The dates fall outside ${who}'s available dates.` });
      }
    }

    // -- duration: at least the agreed number of nights, and less than one night more
    const duration = resolveGroupField(state, 'duration');
    if (duration.status === 'agreed') {
      const nights = (duration.value as ConstraintValues['duration']).nights;
      const hours = (end - start) / MS_PER_HOUR;
      if (hours < nights * 24 || hours > (nights + 1) * 24) {
        violations.push({ kind: 'duration', detail: `The trip should be ${nights} night${nights === 1 ? '' : 's'} long.` });
      }
    }
  }

  // -- must-dos, accessibility and dietary needs
  for (const id of ids) {
    for (const mustDo of effectiveMustDos(state, id)) {
      if (!mustDoMet(candidate, mustDo)) {
        violations.push({ kind: 'must_do', memberId: id, detail: `Nothing in the plan covers "${mustDo}".` });
      }
    }
  }

  // -- region: no single drive longer than the agreed limit (checked only where travel times are known)
  const region = resolveGroupField(state, 'region');
  if (region.status === 'agreed') {
    const limit = (region.value as ConstraintValues['region']).maxTravelMinutes;
    const longest = Math.max(0, ...candidate.itinerary.map((i) => i.travelMinutesFromPrevious ?? 0));
    if (limit !== undefined && longest > limit) {
      violations.push({ kind: 'region', detail: `A drive of ${longest} minutes is longer than the ${limit}-minute limit.` });
    }
  }

  return { feasible: violations.length === 0 && unknownEssentials.length === 0, violations, unknownEssentials };
}

/** The candidate with totals and feasibility recomputed from its own costs against the current state. */
export function reprice(state: TripState, candidate: TripCandidate): TripCandidate {
  const { perPersonTotals } = allocateCosts(participantIds(state), candidate.costs, candidate.contingencyCents);
  return { ...candidate, perPersonTotals, feasibility: validateCandidate(state, candidate) };
}

/**
 * Public wording for a feasibility result: what is over or unverified, without any person's cap.
 * Private amounts (`overByCents`) are for that member's private message only.
 */
export function publicFeasibilitySummary(feasibility: Feasibility): string {
  if (feasibility.feasible) return "Fits everyone's limits on the upper estimate.";
  const lines = feasibility.violations.map((v) => (v.kind === 'budget' ? "The upper estimate is over at least one person's limit." : v.detail));
  if (feasibility.unknownEssentials.length > 0) lines.push('Some essential prices are unknown, so affordability is unverified.');
  return [...new Set(lines)].join(' ');
}

/** The one person's own over-budget amount, for their private message only. */
export function privateOverage(feasibility: Feasibility, memberId: MemberId): string | undefined {
  const v = feasibility.violations.find((x) => x.kind === 'budget' && x.memberId === memberId && x.overByCents !== undefined);
  return v ? `The upper estimate is ${formatUsdWhole(v.overByCents as number)} over your maximum.` : undefined;
}
