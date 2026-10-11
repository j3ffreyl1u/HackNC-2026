import { describe, expect, it } from 'vitest';
import { allocateCosts, privateOverage, publicFeasibilitySummary, reprice, validateCandidate } from '../../src/planning/budget.js';
import { recordConstraint } from '../../src/planning/constraints.js';
import { MoneyError } from '../../src/planning/money.js';
import { createTrip } from '../../src/planning/state.js';
import type { Certainty, ConstraintField, ConstraintUpdate, ConstraintValues, CostItem, TripCandidate, TripState } from '../../src/planning/types.js';

const roster = [
  { memberId: 'mason', displayName: 'Mason', consented: true },
  { memberId: 'alex', displayName: 'Alex', consented: true },
  { memberId: 'jordan', displayName: 'Jordan', consented: true },
];
const ids = roster.map((m) => m.memberId);
const NOW = '2026-10-10T12:00:00.000Z';
const WEEKEND = { startAt: '2026-10-16T17:00:00.000Z', endAt: '2026-10-18T20:00:00.000Z' };

let counter = 0;
function put<F extends ConstraintField>(state: TripState, memberId: string, field: F, value: ConstraintValues[F], certainty: Certainty = 'confirmed'): TripState {
  const update = { memberId, field, value, sourceMessageId: `m-${++counter}`, certainty } as ConstraintUpdate;
  return recordConstraint(state, update, NOW);
}

/** Acceptance fixture: caps 20,000 / 25,000 / 30,000, one weekend, 2 nights, 240-minute drive limit. */
function fixtureState(caps: Record<string, number> = { mason: 20_000, alex: 25_000, jordan: 30_000 }): TripState {
  let state = createTrip('trip-1', roster);
  for (const id of ids) {
    state = put(state, id, 'budget', { cents: caps[id] });
    state = put(state, id, 'availability', { intervals: [WEEKEND] });
    state = put(state, id, 'preferences', { items: ['hiking', 'town visit'] });
    state = put(state, id, 'duration', { nights: 2 });
    state = put(state, id, 'region', { searchRegion: 'NC mountains', maxTravelMinutes: 240 });
  }
  return state;
}

const shared = (costId: string, highCents: number, extra: Partial<CostItem> = {}): CostItem => ({
  costId,
  category: 'accommodation',
  label: costId,
  lowCents: Math.round(highCents * 0.8),
  highCents,
  allocation: 'equal_shared',
  evidenceIds: [],
  priceStatus: 'estimate',
  ...extra,
});
const food = (memberId: string): CostItem => ({
  costId: `food-${memberId}`,
  category: 'food',
  label: 'Food',
  lowCents: 1_500,
  highCents: 2_000,
  allocation: 'personal',
  memberId,
  evidenceIds: [],
  priceStatus: 'estimate',
});

/** Shared upper costs `sharedHigh`, personal food 2,000 each, contingency 1,000 each (3,000 total). */
function candidate(candidateId: string, sharedHigh: number, overrides: Partial<TripCandidate> = {}): TripCandidate {
  return {
    candidateId,
    revision: 1,
    title: candidateId,
    startAt: WEEKEND.startAt,
    endAt: WEEKEND.endAt,
    itinerary: [
      { itemId: 'drive', label: 'Drive to the mountains', location: 'Boone', startAt: WEEKEND.startAt, endAt: '2026-10-16T20:00:00.000Z', travelMinutesFromPrevious: 180, evidenceIds: [], tags: [] },
      { itemId: 'hike', label: 'Day hike', location: 'Grandfather Mountain', startAt: '2026-10-17T14:00:00.000Z', endAt: '2026-10-17T20:00:00.000Z', evidenceIds: [], tags: ['hiking'] },
    ],
    costs: [shared('cabin', sharedHigh), ...ids.map(food)],
    contingencyCents: 3_000,
    perPersonTotals: [],
    evidence: [],
    tradeoffs: [],
    feasibility: { feasible: false, violations: [], unknownEssentials: [] },
    dataSource: 'fixture',
    ...overrides,
  };
}

const totals = (c: TripCandidate) => Object.fromEntries(allocateCosts(ids, c.costs, c.contingencyCents).perPersonTotals.map((t) => [t.memberId, t.highCents]));

describe('allocateCosts', () => {
  it('reproduces the fixture: 48,000 shared gives 19,000 each, 45,000 shared gives 18,000 each', () => {
    expect(totals(candidate('a', 48_000))).toEqual({ mason: 19_000, alex: 19_000, jordan: 19_000 });
    expect(totals(candidate('b', 45_000))).toEqual({ mason: 18_000, alex: 18_000, jordan: 18_000 });
  });

  it('splits so that per-person amounts sum exactly to the total, remainders to the earliest people', () => {
    const c = candidate('odd', 10_000, { costs: [shared('cabin', 10_000)], contingencyCents: 0 });
    const result = allocateCosts(ids, c.costs, 0).perPersonTotals;
    expect(result.map((t) => t.highCents)).toEqual([3_334, 3_333, 3_333]);
    expect(result.reduce((n, t) => n + t.highCents, 0)).toBe(10_000);
  });

  it('splits shared costs and contingency together so one person does not take both remainders', () => {
    const result = allocateCosts(ids, [shared('cabin', 10_000)], 1).perPersonTotals;
    // 10,001 = 3,333 x 3 + 2: the first two people take one extra cent each.
    expect(result.map((t) => t.highCents)).toEqual([3_334, 3_334, 3_333]);
    expect(result.reduce((n, t) => n + t.highCents, 0)).toBe(10_001);
  });

  it('puts a personal cost on its owner only', () => {
    const extra: CostItem = { ...food('alex'), costId: 'rental', label: 'Boot rental', lowCents: 4_000, highCents: 5_000 };
    const base = totals(candidate('a', 48_000));
    const c = candidate('a', 48_000);
    c.costs.push(extra);
    expect(totals(c)).toEqual({ mason: base.mason, alex: base.alex + 5_000, jordan: base.jordan });
  });

  it('counts contingency toward the high total but not the low one', () => {
    const result = allocateCosts(ids, [shared('cabin', 9_000, { lowCents: 6_000 })], 3_000).perPersonTotals;
    expect(result[0]).toMatchObject({ lowCents: 2_000, highCents: 4_000 });
  });

  it('never treats an unknown essential price as zero', () => {
    const unknown = shared('gas', 0, { priceStatus: 'unknown', lowCents: 0, highCents: 0, category: 'fuel_parking_tolls' });
    const result = allocateCosts(ids, [shared('cabin', 9_000), unknown], 0);
    expect(result.unknownEssentials).toEqual(['gas']);
  });

  it('does not block on an unknown cost that was marked non-essential', () => {
    const optional = shared('souvenirs', 0, { priceStatus: 'unknown', essential: false });
    expect(allocateCosts(ids, [shared('cabin', 9_000), optional], 0).unknownEssentials).toEqual([]);
  });

  it('treats a verified zero as a real price', () => {
    const free = shared('trail', 0, { priceStatus: 'verified', lowCents: 0, highCents: 0, category: 'activities' });
    expect(allocateCosts(ids, [free], 0).unknownEssentials).toEqual([]);
  });

  it.each([
    ['a personal cost with no owner', { ...food('mason'), memberId: undefined }],
    ['a personal cost for a stranger', food('casey')],
    ['a shared cost that names a person', shared('cabin', 9_000, { memberId: 'mason' })],
    ['a low estimate above the high', shared('cabin', 9_000, { lowCents: 9_500 })],
    ['fractional cents', shared('cabin', 9_000.5)],
    ['a negative cost', shared('cabin', -1, { lowCents: -1 })],
  ])('rejects %s', (_label, cost) => {
    expect(() => allocateCosts(ids, [cost as CostItem], 0)).toThrow(MoneyError);
  });

  it('rejects duplicate cost IDs and a bad contingency', () => {
    expect(() => allocateCosts(ids, [shared('x', 100), shared('x', 100)], 0)).toThrow(MoneyError);
    expect(() => allocateCosts(ids, [shared('x', 100)], -5)).toThrow(MoneyError);
  });
});

describe('validateCandidate: money', () => {
  it('both fixture options fit every cap, and the sum of caps (75,000) plays no part', () => {
    const state = fixtureState();
    expect(validateCandidate(state, candidate('a', 48_000))).toEqual({ feasible: true, violations: [], unknownEssentials: [] });
    expect(validateCandidate(state, candidate('b', 45_000)).feasible).toBe(true);
  });

  it('an exactly-equal total fits; one cent over (on the person who takes the remainder) does not', () => {
    const state = fixtureState({ mason: 18_000, alex: 18_000, jordan: 18_000 });
    expect(validateCandidate(state, candidate('b', 45_000)).feasible).toBe(true);
    const over = validateCandidate(state, candidate('c', 45_001));
    expect(over.feasible).toBe(false);
    expect(over.violations).toMatchObject([{ kind: 'budget', memberId: 'mason', overByCents: 1 }]);
  });

  it('lowering one cap to 18,000 rejects the 19,000 option and keeps the 18,000 one', () => {
    const state = fixtureState({ mason: 18_000, alex: 25_000, jordan: 30_000 });
    const expensive = validateCandidate(state, candidate('a', 48_000));
    expect(expensive.feasible).toBe(false);
    expect(expensive.violations).toEqual([expect.objectContaining({ kind: 'budget', memberId: 'mason', overByCents: 1_000 })]);
    expect(validateCandidate(state, candidate('b', 45_000)).feasible).toBe(true);
  });

  it('large caps elsewhere do not rescue the person with a low cap', () => {
    const state = fixtureState({ mason: 10_000, alex: 1_000_000, jordan: 1_000_000 });
    const result = validateCandidate(state, candidate('b', 45_000));
    expect(result.violations.map((v) => v.memberId)).toEqual(['mason']);
  });

  it('personal costs and contingency count against the cap', () => {
    // Shared share is 15,000; only food (2,000) and contingency (1,000) push Mason over 17,500.
    const state = fixtureState({ mason: 17_500, alex: 25_000, jordan: 30_000 });
    expect(validateCandidate(state, candidate('b', 45_000)).violations).toMatchObject([{ memberId: 'mason', overByCents: 500 }]);
  });

  it('one person’s personal expense can break only their own cap', () => {
    const state = fixtureState();
    const c = candidate('a', 45_000);
    c.costs.push({ ...food('jordan'), costId: 'gear', lowCents: 11_000, highCents: 13_000 });
    const result = validateCandidate(state, c);
    expect(result.violations).toMatchObject([{ kind: 'budget', memberId: 'jordan', overByCents: 1_000 }]);
  });

  it('an unknown essential price is unverified, not proven feasible, and not called a violation', () => {
    const state = fixtureState();
    const c = candidate('a', 30_000);
    c.costs.push(shared('gas', 0, { priceStatus: 'unknown', lowCents: 0, highCents: 0, category: 'fuel_parking_tolls' }));
    expect(validateCandidate(state, c)).toEqual({ feasible: false, violations: [], unknownEssentials: ['gas'] });
  });

  it('a person with no recorded cap cannot be proven to afford it', () => {
    let state = createTrip('t', roster);
    for (const id of ['mason', 'alex']) state = put(state, id, 'budget', { cents: 30_000 });
    for (const id of ids) state = put(state, id, 'availability', { intervals: [WEEKEND] });
    const result = validateCandidate(state, candidate('b', 45_000));
    expect(result.feasible).toBe(false);
    expect(result.violations).toMatchObject([{ kind: 'budget', memberId: 'jordan' }]);
  });

  it('a tentative cap does not count; the last confirmed one is enforced', () => {
    const state = put(fixtureState(), 'mason', 'budget', { cents: 5_000 }, 'tentative');
    expect(validateCandidate(state, candidate('a', 48_000)).feasible).toBe(true);
  });

  it('ignores totals the candidate claims and uses its costs', () => {
    const lie = candidate('a', 48_000, { perPersonTotals: ids.map((memberId) => ({ memberId, lowCents: 1, highCents: 1 })) });
    expect(validateCandidate(fixtureState({ mason: 18_000, alex: 25_000, jordan: 30_000 }), lie).feasible).toBe(false);
  });
});

describe('validateCandidate: dates, duration, must-dos, region', () => {
  it('rejects dates outside someone’s window and names only that person', () => {
    let state = fixtureState();
    state = put(state, 'alex', 'availability', { intervals: [{ startAt: '2026-10-23T17:00:00.000Z', endAt: '2026-10-25T20:00:00.000Z' }] });
    const result = validateCandidate(state, candidate('b', 45_000));
    expect(result.violations).toMatchObject([{ kind: 'availability', memberId: 'alex' }]);
  });

  it('requires the whole trip to fit inside one window, not across two', () => {
    let state = fixtureState();
    const split = [
      { startAt: '2026-10-16T17:00:00.000Z', endAt: '2026-10-17T12:00:00.000Z' },
      { startAt: '2026-10-17T18:00:00.000Z', endAt: '2026-10-18T20:00:00.000Z' },
    ];
    state = put(state, 'jordan', 'availability', { intervals: split });
    expect(validateCandidate(state, candidate('b', 45_000)).violations).toMatchObject([{ kind: 'availability', memberId: 'jordan' }]);
  });

  it('rejects a trip that is too short or too long for the agreed nights', () => {
    const state = fixtureState();
    const short = candidate('s', 45_000, { endAt: '2026-10-17T20:00:00.000Z' });
    const long = candidate('l', 45_000, { endAt: '2026-10-19T20:00:00.000Z' });
    expect(validateCandidate(state, short).violations.map((v) => v.kind)).toContain('duration');
    // The long one is also outside everyone's window.
    expect(validateCandidate(state, long).violations.map((v) => v.kind)).toEqual(expect.arrayContaining(['duration', 'availability']));
  });

  it('rejects invalid dates', () => {
    const result = validateCandidate(fixtureState(), candidate('x', 45_000, { startAt: 'soon', endAt: WEEKEND.endAt }));
    expect(result.violations.map((v) => v.kind)).toEqual(['availability']);
  });

  it('a confirmed must-do has to appear in the plan', () => {
    const state = put(fixtureState(), 'alex', 'must_dos', { items: ['waterfall'] });
    expect(validateCandidate(state, candidate('b', 45_000)).violations).toMatchObject([{ kind: 'must_do', memberId: 'alex' }]);
    const c = candidate('b', 45_000);
    c.itinerary[1].tags.push('Waterfall');
    expect(validateCandidate(state, c).feasible).toBe(true);
  });

  it('a tentative must-do is not enforced', () => {
    const state = put(fixtureState(), 'alex', 'must_dos', { items: ['waterfall'] }, 'tentative');
    expect(validateCandidate(state, candidate('b', 45_000)).feasible).toBe(true);
  });

  it('rejects a drive longer than the agreed limit', () => {
    const c = candidate('far', 45_000);
    c.itinerary[0].travelMinutesFromPrevious = 300;
    expect(validateCandidate(fixtureState(), c).violations).toMatchObject([{ kind: 'region' }]);
  });
});

describe('reprice and summaries', () => {
  it('reprice fills totals and feasibility from the current state', () => {
    const priced = reprice(fixtureState(), candidate('a', 48_000));
    expect(priced.perPersonTotals).toEqual(ids.map((memberId) => ({ memberId, lowCents: expect.any(Number), highCents: 19_000 })));
    expect(priced.feasibility.feasible).toBe(true);
  });

  it('the public summary never carries a cap or the amount over it', () => {
    const state = fixtureState({ mason: 18_000, alex: 25_000, jordan: 30_000 });
    const result = validateCandidate(state, candidate('a', 48_000));
    const text = publicFeasibilitySummary(result);
    expect(text).toMatch(/over at least one person/);
    expect(text).not.toMatch(/\$|1,?000|18,?000|Mason/);
    for (const v of result.violations) expect(v.detail).not.toMatch(/\$|\d{3,}|Mason/);
  });

  it('only that person gets their own overage, and only privately', () => {
    const result = validateCandidate(fixtureState({ mason: 18_000, alex: 25_000, jordan: 30_000 }), candidate('a', 48_000));
    expect(privateOverage(result, 'mason')).toBe('The upper estimate is $10 over your maximum.');
    expect(privateOverage(result, 'alex')).toBeUndefined();
  });

  it('unknowns are named in the public summary', () => {
    const c = candidate('a', 30_000);
    c.costs.push(shared('gas', 0, { priceStatus: 'unknown' }));
    expect(publicFeasibilitySummary(validateCandidate(fixtureState(), c))).toMatch(/unverified/);
  });
});
