import { describe, expect, it } from 'vitest';
import {
  ConstraintError,
  commonWindows,
  effectiveAvailability,
  effectiveBudget,
  effectiveMustDos,
  hasUnconfirmedChange,
  hoursNeeded,
  latestConfirmed,
  normalizeIntervals,
  parseTimestamp,
  recordConstraint,
  resolveGroupField,
  statedPreferences,
  validateUpdate,
} from '../../src/planning/constraints.js';
import { createTrip, participantIds } from '../../src/planning/state.js';
import type { Certainty, ConstraintUpdate, TripState } from '../../src/planning/types.js';

const roster = [
  { memberId: 'mason', displayName: 'Mason', consented: true },
  { memberId: 'alex', displayName: 'Alex', consented: true },
  { memberId: 'jordan', displayName: 'Jordan', consented: true },
];

const NOW = '2026-10-10T12:00:00.000Z';
let counter = 0;

const budget = (memberId: string, cents: number, certainty: Certainty = 'confirmed'): ConstraintUpdate => ({
  memberId,
  field: 'budget',
  value: { cents },
  sourceMessageId: `m-${++counter}`,
  certainty,
});

function apply(state: TripState, actor: string, update: ConstraintUpdate): TripState {
  return recordConstraint(state, validateUpdate(state, actor, update), NOW);
}

const rejection = (fn: () => unknown): ConstraintError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConstraintError) return error;
    throw error;
  }
  throw new Error('expected a ConstraintError');
};

describe('createTrip', () => {
  it('starts gathering at revision 1 with nothing known and funding off', () => {
    const trip = createTrip('trip-1', roster);
    expect(trip).toMatchObject({ tripId: 'trip-1', revision: 1, status: 'gathering', fundingStatus: 'disabled', candidates: [], acceptances: [] });
    expect(trip.memberConstraints).toEqual({ mason: [], alex: [], jordan: [] });
    expect(participantIds(trip)).toEqual(['mason', 'alex', 'jordan']);
  });

  it('only consenting members take part', () => {
    const trip = createTrip('t', [...roster, { memberId: 'sam', displayName: 'Sam', consented: false }]);
    expect(participantIds(trip)).toEqual(['mason', 'alex', 'jordan']);
  });
});

describe('who may change what', () => {
  const trip = createTrip('t', [...roster, { memberId: 'sam', displayName: 'Sam', consented: false }]);

  it('rejects an unknown actor and one who has not consented', () => {
    expect(rejection(() => validateUpdate(trip, 'stranger', budget('stranger', 10_000))).code).toBe('UNKNOWN_MEMBER');
    expect(rejection(() => validateUpdate(trip, 'sam', budget('sam', 10_000))).code).toBe('UNKNOWN_MEMBER');
  });

  it("never lets anyone change another member's limits", () => {
    const error = rejection(() => validateUpdate(trip, 'alex', budget('mason', 1_000)));
    expect(error.code).toBe('INVALID_CONSTRAINT');
    expect(error.userMessage).toContain('your own');
  });

  it('requires a source message and a clear firm-or-tentative marker', () => {
    expect(rejection(() => validateUpdate(trip, 'mason', { ...budget('mason', 100), sourceMessageId: '' })).code).toBe('INVALID_CONSTRAINT');
    expect(rejection(() => validateUpdate(trip, 'mason', { ...budget('mason', 100), certainty: 'maybe' as Certainty })).code).toBe('INVALID_CONSTRAINT');
  });
});

describe('value validation', () => {
  const trip = createTrip('t', roster);
  const check = (update: ConstraintUpdate) => validateUpdate(trip, update.memberId, update);
  const base = { memberId: 'mason', sourceMessageId: 'm', certainty: 'confirmed' as const };

  it.each([0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects budget %s', (cents) => {
    expect(rejection(() => check({ ...base, field: 'budget', value: { cents } })).code).toBe('INVALID_CONSTRAINT');
  });

  it('accepts a positive budget in whole cents', () => {
    expect(check({ ...base, field: 'budget', value: { cents: 20_000 } }).value).toEqual({ cents: 20_000 });
  });

  it('normalizes preferences: trimmed, lowercase, de-duplicated and sorted', () => {
    const out = check({ ...base, field: 'preferences', value: { items: ['  Hiking ', 'town   visit', 'hiking'] } });
    expect(out.value).toEqual({ items: ['hiking', 'town visit'] });
  });

  it('accepts "no preference" alone but not mixed, and not an empty list', () => {
    expect(check({ ...base, field: 'preferences', value: { items: ['No Preference'] } }).value).toEqual({ items: ['no preference'] });
    expect(rejection(() => check({ ...base, field: 'preferences', value: { items: ['no preference', 'hiking'] } })).code).toBe('INVALID_CONSTRAINT');
    expect(rejection(() => check({ ...base, field: 'preferences', value: { items: [] } })).code).toBe('INVALID_CONSTRAINT');
  });

  it('allows an empty must-do list (no hard requirements) but bounds its size and text', () => {
    expect(check({ ...base, field: 'must_dos', value: { items: [] } }).value).toEqual({ items: [] });
    expect(rejection(() => check({ ...base, field: 'must_dos', value: { items: Array.from({ length: 21 }, (_, i) => `x${i}`) } })).code).toBe('INVALID_CONSTRAINT');
    expect(rejection(() => check({ ...base, field: 'must_dos', value: { items: ['a'.repeat(81)] } })).code).toBe('INVALID_CONSTRAINT');
    expect(rejection(() => check({ ...base, field: 'must_dos', value: { items: ['vegan\u0000'] } })).code).toBe('INVALID_CONSTRAINT');
  });

  it('supports a trip by car or by plane, and a car needs a clear yes or no on the vehicle', () => {
    expect(check({ ...base, field: 'transport', value: { mode: 'car', vehicleAvailable: true } }).value).toEqual({ mode: 'car', vehicleAvailable: true });
    expect(check({ ...base, field: 'transport', value: { mode: 'plane', vehicleAvailable: false } }).value).toEqual({ mode: 'plane', vehicleAvailable: false });   // flying needs no car
    expect(rejection(() => check({ ...base, field: 'transport', value: { mode: 'train' as 'car', vehicleAvailable: true } })).code).toBe('INVALID_CONSTRAINT');
    expect(rejection(() => check({ ...base, field: 'transport', value: { mode: 'car', vehicleAvailable: 'yes' as unknown as boolean } })).code).toBe('INVALID_CONSTRAINT');
  });

  it('a region needs a destination, a region name or a travel-time limit, and bounds the limit', () => {
    expect(check({ ...base, field: 'region', value: { destination: ' Asheville ' } }).value).toEqual({ destination: 'Asheville' });
    expect(check({ ...base, field: 'region', value: { maxTravelMinutes: 180 } }).value).toEqual({ maxTravelMinutes: 180 });
    expect(rejection(() => check({ ...base, field: 'region', value: {} })).code).toBe('INVALID_CONSTRAINT');
    for (const maxTravelMinutes of [0, -1, 2.5, 24 * 60 + 1]) {
      expect(rejection(() => check({ ...base, field: 'region', value: { maxTravelMinutes } })).code).toBe('INVALID_CONSTRAINT');
    }
  });

  it('duration is a whole number of nights from 1 to 30', () => {
    expect(check({ ...base, field: 'duration', value: { nights: 2 } }).value).toEqual({ nights: 2 });
    for (const nights of [0, 31, 1.5, -1]) {
      expect(rejection(() => check({ ...base, field: 'duration', value: { nights } })).code).toBe('INVALID_CONSTRAINT');
    }
  });

  it('origin must be a non-empty bounded city', () => {
    expect(check({ ...base, field: 'origin', value: { city: ' Chapel   Hill ' } }).value).toEqual({ city: 'Chapel Hill' });
    expect(rejection(() => check({ ...base, field: 'origin', value: { city: '   ' } })).code).toBe('INVALID_CONSTRAINT');
  });

  it('rejects an unrecognized field', () => {
    expect(rejection(() => check({ ...base, field: 'mood', value: {} } as unknown as ConstraintUpdate)).code).toBe('INVALID_CONSTRAINT');
  });
});

describe('timestamps and windows', () => {
  it('parses only exact ISO timestamps that state a timezone', () => {
    expect(parseTimestamp('2026-10-16T17:00:00-04:00')).toBe(Date.parse('2026-10-16T21:00:00Z'));
    expect(parseTimestamp('2026-10-16T17:00Z')).toBe(Date.parse('2026-10-16T17:00:00Z'));
    for (const bad of ['2026-10-16', '2026-10-16T17:00', '10/16/2026', '2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z', '2026-10-16T25:00:00Z', 42, null]) {
      expect(parseTimestamp(bad)).toBeNull();
    }
  });

  it('sorts and merges overlapping or touching windows, in UTC', () => {
    const merged = normalizeIntervals([
      { startAt: '2026-10-17T12:00:00Z', endAt: '2026-10-18T12:00:00Z' },
      { startAt: '2026-10-16T12:00:00Z', endAt: '2026-10-17T12:00:00Z' },
      { startAt: '2026-10-23T12:00:00Z', endAt: '2026-10-24T12:00:00Z' },
    ]);
    expect(merged).toEqual([
      { startAt: '2026-10-16T12:00:00.000Z', endAt: '2026-10-18T12:00:00.000Z' },
      { startAt: '2026-10-23T12:00:00.000Z', endAt: '2026-10-24T12:00:00.000Z' },
    ]);
  });

  it('rejects empty, reversed and timezone-less windows', () => {
    expect(() => normalizeIntervals([])).toThrow(ConstraintError);
    expect(() => normalizeIntervals([{ startAt: '2026-10-17T12:00:00Z', endAt: '2026-10-16T12:00:00Z' }])).toThrow(/end after they start/);
    expect(() => normalizeIntervals([{ startAt: '2026-10-16T12:00', endAt: '2026-10-17T12:00' }])).toThrow(/timezone/);
  });

  it('finds what every member has in common, across timezones, long enough for the trip', () => {
    const mason = [{ startAt: '2026-10-16T17:00:00-04:00', endAt: '2026-10-18T20:00:00-04:00' }];
    const alex = [{ startAt: '2026-10-16T22:00:00Z', endAt: '2026-10-19T00:00:00Z' }];
    const jordan = [{ startAt: '2026-10-16T12:00:00Z', endAt: '2026-10-18T22:00:00Z' }];
    expect(commonWindows([mason, alex, jordan])).toEqual([{ startAt: '2026-10-16T22:00:00.000Z', endAt: '2026-10-18T22:00:00.000Z' }]);
    expect(commonWindows([mason, alex, jordan], hoursNeeded(2))).toHaveLength(1);
    expect(commonWindows([mason, alex, jordan], hoursNeeded(3))).toEqual([]);
  });

  it('is empty when there is no overlap, and for no members', () => {
    const a = [{ startAt: '2026-10-16T12:00:00Z', endAt: '2026-10-17T12:00:00Z' }];
    const b = [{ startAt: '2026-10-23T12:00:00Z', endAt: '2026-10-24T12:00:00Z' }];
    expect(commonWindows([a, b])).toEqual([]);
    expect(commonWindows([])).toEqual([]);
  });
});

describe('recording and reading constraints', () => {
  it('stores each update with its author, source message and revision, and never mutates the old state', () => {
    const trip = createTrip('t', roster);
    const next = apply(trip, 'mason', budget('mason', 20_000));
    expect(trip.memberConstraints.mason).toEqual([]);
    expect(next.memberConstraints.mason).toHaveLength(1);
    expect(next.memberConstraints.mason[0]).toMatchObject({
      memberId: 'mason',
      field: 'budget',
      certainty: 'confirmed',
      recordedAt: NOW,
      revision: 1,
    });
    expect(next.memberConstraints.mason[0].sourceMessageId).toMatch(/^m-/);
  });

  it('keeps three different members\' limits separate', () => {
    let trip = createTrip('t', roster);
    trip = apply(trip, 'mason', budget('mason', 20_000));
    trip = apply(trip, 'alex', budget('alex', 25_000));
    trip = apply(trip, 'jordan', budget('jordan', 30_000));
    expect([effectiveBudget(trip, 'mason'), effectiveBudget(trip, 'alex'), effectiveBudget(trip, 'jordan')]).toEqual([20_000, 25_000, 30_000]);
  });

  it("a member's latest confirmed statement replaces their earlier one", () => {
    let trip = createTrip('t', roster);
    trip = apply(trip, 'mason', budget('mason', 20_000));
    trip = apply(trip, 'mason', budget('mason', 18_000));
    expect(effectiveBudget(trip, 'mason')).toBe(18_000);
  });

  it('a tentative statement is not effective', () => {
    let trip = createTrip('t', roster);
    trip = apply(trip, 'alex', budget('alex', 25_000, 'tentative'));
    expect(effectiveBudget(trip, 'alex')).toBeUndefined();
    expect(latestConfirmed(trip, 'alex', 'budget')).toBeUndefined();
  });

  it('a tentative change after a confirmed limit is flagged, while the confirmed value stays in force', () => {
    let trip = createTrip('t', roster);
    trip = apply(trip, 'alex', budget('alex', 25_000));
    expect(hasUnconfirmedChange(trip, 'alex', 'budget')).toBe(false);
    trip = apply(trip, 'alex', budget('alex', 15_000, 'tentative'));
    expect(effectiveBudget(trip, 'alex')).toBe(25_000);
    expect(hasUnconfirmedChange(trip, 'alex', 'budget')).toBe(true);
    trip = apply(trip, 'alex', budget('alex', 15_000));
    expect(effectiveBudget(trip, 'alex')).toBe(15_000);
    expect(hasUnconfirmedChange(trip, 'alex', 'budget')).toBe(false);
  });

  it('reads availability, must-dos and preferences (any certainty for preferences)', () => {
    let trip = createTrip('t', roster);
    const windows = [{ startAt: '2026-10-16T17:00:00-04:00', endAt: '2026-10-18T20:00:00-04:00' }];
    trip = apply(trip, 'mason', { memberId: 'mason', field: 'availability', value: { intervals: windows }, sourceMessageId: 'a', certainty: 'confirmed' });
    trip = apply(trip, 'mason', { memberId: 'mason', field: 'must_dos', value: { items: ['Vegetarian food'] }, sourceMessageId: 'b', certainty: 'confirmed' });
    trip = apply(trip, 'alex', { memberId: 'alex', field: 'preferences', value: { items: ['Hiking'] }, sourceMessageId: 'c', certainty: 'tentative' });
    expect(effectiveAvailability(trip, 'mason')).toEqual([{ startAt: '2026-10-16T21:00:00.000Z', endAt: '2026-10-19T00:00:00.000Z' }]);
    expect(effectiveMustDos(trip, 'mason')).toEqual(['vegetarian food']);
    expect(effectiveMustDos(trip, 'alex')).toEqual([]);
    expect(statedPreferences(trip, 'alex')).toEqual(['hiking']);
    expect(statedPreferences(trip, 'jordan')).toBeUndefined();
  });

  it('a later preference adds to earlier ones, and "no preference" resets them', () => {
    let trip = createTrip('t', roster);
    const say = (items: string[], id: string) => {
      trip = apply(trip, 'alex', { memberId: 'alex', field: 'preferences', value: { items }, sourceMessageId: id, certainty: 'confirmed' });
    };
    say(['Hiking'], 'p1');
    say(['historical places'], 'p2');
    say(['hiking', 'food'], 'p3');
    expect(statedPreferences(trip, 'alex')).toEqual(['food', 'hiking', 'historical places']);
    say(['no preference'], 'p4');
    expect(statedPreferences(trip, 'alex')).toEqual(['no preference']);
    say(['beach'], 'p5');
    expect(statedPreferences(trip, 'alex')).toEqual(['beach']);
    expect(statedPreferences(trip, 'mason')).toBeUndefined();
  });

  it('a tentative must-do is not enforced', () => {
    let trip = createTrip('t', roster);
    trip = apply(trip, 'mason', { memberId: 'mason', field: 'must_dos', value: { items: ['waterfall'] }, sourceMessageId: 'x', certainty: 'tentative' });
    expect(effectiveMustDos(trip, 'mason')).toEqual([]);
    expect(hasUnconfirmedChange(trip, 'mason', 'must_dos')).toBe(true);
  });
});

describe('group-level fields', () => {
  const duration = (memberId: string, nights: number, certainty: Certainty = 'confirmed'): ConstraintUpdate => ({
    memberId,
    field: 'duration',
    value: { nights },
    sourceMessageId: `d-${++counter}`,
    certainty,
  });

  it('is unset until someone confirms it', () => {
    const trip = createTrip('t', roster);
    expect(resolveGroupField(trip, 'duration')).toEqual({ status: 'unset', tentativeOnly: false });
  });

  it('a tentative statement does not count, but is noticed', () => {
    const trip = apply(createTrip('t', roster), 'mason', duration('mason', 2, 'tentative'));
    expect(resolveGroupField(trip, 'duration')).toEqual({ status: 'unset', tentativeOnly: true });
  });

  it('one confirmation is effective, because silence is not disagreement', () => {
    const trip = apply(createTrip('t', roster), 'mason', duration('mason', 2));
    expect(resolveGroupField(trip, 'duration')).toEqual({ status: 'agreed', value: { nights: 2 }, authors: ['mason'] });
  });

  it('agreeing confirmations are effective together', () => {
    let trip = apply(createTrip('t', roster), 'mason', duration('mason', 2));
    trip = apply(trip, 'alex', duration('alex', 2));
    expect(resolveGroupField(trip, 'duration')).toMatchObject({ status: 'agreed', authors: ['mason', 'alex'] });
  });

  it('different confirmed answers from different members are a conflict naming both', () => {
    let trip = apply(createTrip('t', roster), 'mason', duration('mason', 2));
    trip = apply(trip, 'alex', duration('alex', 3));
    expect(resolveGroupField(trip, 'duration')).toEqual({
      status: 'conflict',
      positions: [
        { memberId: 'mason', value: { nights: 2 } },
        { memberId: 'alex', value: { nights: 3 } },
      ],
    });
  });

  it('a member restating their own answer resolves the conflict', () => {
    let trip = apply(createTrip('t', roster), 'mason', duration('mason', 2));
    trip = apply(trip, 'alex', duration('alex', 3));
    trip = apply(trip, 'alex', duration('alex', 2));
    expect(resolveGroupField(trip, 'duration')).toMatchObject({ status: 'agreed', value: { nights: 2 } });
  });

  it('compares structured values regardless of key order and letter case', () => {
    const region = (memberId: string, value: { destination?: string; maxTravelMinutes?: number }): ConstraintUpdate => ({
      memberId,
      field: 'region',
      value,
      sourceMessageId: `r-${++counter}`,
      certainty: 'confirmed',
    });
    let trip = apply(createTrip('t', roster), 'mason', region('mason', { destination: 'Asheville', maxTravelMinutes: 180 }));
    trip = apply(trip, 'alex', region('alex', { maxTravelMinutes: 180, destination: 'ASHEVILLE' }));
    expect(resolveGroupField(trip, 'region').status).toBe('agreed');
  });

  it('ignores statements from people who are not participating', () => {
    const withSam = createTrip('t', [...roster, { memberId: 'sam', displayName: 'Sam', consented: false }]);
    expect(() => validateUpdate(withSam, 'sam', duration('sam', 9))).toThrow(ConstraintError);
    expect(resolveGroupField(withSam, 'duration').status).toBe('unset');
  });
});
