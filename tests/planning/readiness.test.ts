import { describe, expect, it } from 'vitest';
import { recordConstraint } from '../../src/planning/constraints.js';
import { checkReadiness, openQuestionKeys } from '../../src/planning/readiness.js';
import {
  BUDGET_QUESTION,
  MAX_QUESTIONS_PER_TURN,
  QUESTION_COOLDOWN_MS,
  clearAnsweredQuestions,
  fieldForKey,
  recordQuestions,
} from '../../src/planning/questions.js';
import { createTrip } from '../../src/planning/state.js';
import type { Certainty, ConstraintField, ConstraintUpdate, ConstraintValues, TripState } from '../../src/planning/types.js';

const roster = [
  { memberId: 'mason', displayName: 'Mason', consented: true },
  { memberId: 'alex', displayName: 'Alex', consented: true },
  { memberId: 'jordan', displayName: 'Jordan', consented: true },
];
const members = roster.map((m) => m.memberId);

const NOW = '2026-10-10T12:00:00.000Z';
const CAPS: Record<string, number> = { mason: 20_000, alex: 25_000, jordan: 30_000 };
// Friday 17:00 to Sunday 20:00 UTC: 51 hours, enough for two nights.
const WEEKEND = { startAt: '2026-10-16T17:00:00.000Z', endAt: '2026-10-18T20:00:00.000Z' };
const OTHER_WEEKEND = { startAt: '2026-10-23T17:00:00.000Z', endAt: '2026-10-25T20:00:00.000Z' };

let counter = 0;
function put<F extends ConstraintField>(
  state: TripState,
  memberId: string,
  field: F,
  value: ConstraintValues[F],
  certainty: Certainty = 'confirmed',
): TripState {
  const update = { memberId, field, value, sourceMessageId: `m-${++counter}`, certainty } as ConstraintUpdate;
  return recordConstraint(state, update, NOW);
}

type Slot = 'origin' | 'duration' | 'region' | 'transport' | 'availability' | 'budget' | 'preferences';

/** The canonical three-person fixture, with any listed slots left unanswered. */
function trip(omit: Slot[] = [], people = roster): TripState {
  let state = createTrip('trip-1', people);
  const ids = people.map((m) => m.memberId);
  for (const id of ids) {
    if (!omit.includes('availability')) state = put(state, id, 'availability', { intervals: [WEEKEND, OTHER_WEEKEND] });
    if (!omit.includes('budget')) state = put(state, id, 'budget', { cents: CAPS[id] ?? 20_000 });
    if (!omit.includes('preferences')) state = put(state, id, 'preferences', { items: ['hiking'] });
    if (!omit.includes('origin')) state = put(state, id, 'origin', { city: 'Chapel Hill' });
    if (!omit.includes('duration')) state = put(state, id, 'duration', { nights: 2 });
    if (!omit.includes('region')) state = put(state, id, 'region', { searchRegion: 'NC mountains', maxTravelMinutes: 240 });
    if (!omit.includes('transport')) state = put(state, id, 'transport', { mode: 'car', vehicleAvailable: true });
  }
  return state;
}

describe('checkReadiness: the complete fixture', () => {
  it('is ready with nothing missing, no conflicts and nothing to ask', () => {
    expect(checkReadiness(trip())).toEqual({ ready: true, missing: [], conflicts: [], questions: [] });
  });

  it('accepts "no preference" as a stated preference', () => {
    let state = trip(['preferences']);
    for (const id of members) state = put(state, id, 'preferences', { items: ['no preference'] });
    expect(checkReadiness(state).ready).toBe(true);
  });

  it('does not depend on how much has been said, only on recorded constraints', () => {
    const quiet = trip();
    const chatty = { ...quiet, revision: quiet.revision + 50 };
    expect(checkReadiness(chatty)).toEqual(checkReadiness(quiet));
  });
});

describe('checkReadiness: every required slot blocks readiness', () => {
  it.each([
    ['origin', 'origin'],
    ['duration', 'duration'],
    ['region', 'region'],
    ['transport', 'transport'],
  ] as const)('missing %s is reported', (slot, key) => {
    const result = checkReadiness(trip([slot]));
    expect(result.ready).toBe(false);
    expect(result.missing).toContain(key);
    expect(result.questions.length).toBeGreaterThan(0);
  });

  it('missing availability is reported per participant', () => {
    const result = checkReadiness(trip(['availability']));
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(members.map((id) => `availability:${id}`));
  });

  it('a single missing availability names only that person', () => {
    let state = trip(['availability']);
    for (const id of ['mason', 'alex']) state = put(state, id, 'availability', { intervals: [WEEKEND] });
    const result = checkReadiness(state);
    expect(result.missing).toEqual(['availability:jordan']);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].audience).toEqual({ kind: 'private', memberId: 'jordan' });
    expect(result.questions[0].key).toBe('availability:jordan');
    expect(result.questions[0].text).not.toMatch(/Mason|Alex|Jordan/);
  });

  it('personal questions about dates and tastes go only to the person they are about', () => {
    for (const slot of ['availability', 'preferences'] as const) {
      const result = checkReadiness(trip([slot]));
      expect(result.questions.map((q) => q.audience)).toEqual(members.map((memberId) => ({ kind: 'private', memberId })));
      for (const q of result.questions) expect(q.text).not.toMatch(/Mason|Alex|Jordan/);
    }
  });

  it('the two-question limit applies to each recipient, not across everyone', () => {
    const result = checkReadiness(trip(['budget', 'availability', 'preferences']));
    const perPerson = new Map<string, number>();
    for (const q of result.questions) {
      const who = q.audience.kind === 'private' ? q.audience.memberId : 'group';
      perPerson.set(who, (perPerson.get(who) ?? 0) + 1);
    }
    for (const count of perPerson.values()) expect(count).toBeLessThanOrEqual(MAX_QUESTIONS_PER_TURN);
    // Asking everyone their cap in one turn is fine because each person gets only their own.
    expect(checkReadiness(trip(['budget'])).questions).toHaveLength(members.length);
  });

  it('missing budgets are reported per participant', () => {
    const result = checkReadiness(trip(['budget']));
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(members.map((id) => `budget:${id}`));
  });

  it('missing preferences are reported per participant', () => {
    const result = checkReadiness(trip(['preferences']));
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(members.map((id) => `preferences:${id}`));
  });

  it('a car is required for the road-trip MVP', () => {
    let state = trip(['transport']);
    for (const id of members) state = put(state, id, 'transport', { mode: 'car', vehicleAvailable: false });
    const result = checkReadiness(state);
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('vehicle');
    expect(result.missing).not.toContain('transport');
  });

  it('a destination alone, or a travel-time bound alone, satisfies the region', () => {
    for (const region of [{ destination: 'Asheville' }, { maxTravelMinutes: 180 }]) {
      let state = trip(['region']);
      for (const id of members) state = put(state, id, 'region', region);
      expect(checkReadiness(state).missing).not.toContain('region');
    }
  });
});

describe('checkReadiness: people', () => {
  it('waits for a member who has not consented and never counts them', () => {
    const people = roster.map((m) => (m.memberId === 'jordan' ? { ...m, consented: false } : m));
    const result = checkReadiness(trip([], people));
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('consent:jordan');
    expect(result.questions[0].text).toContain('Jordan');
    // Only consenting people are asked for details.
    expect(result.missing.some((k) => k.endsWith(':jordan') && !k.startsWith('consent'))).toBe(false);
  });

  it('needs at least two participants', () => {
    const result = checkReadiness(trip([], roster.slice(0, 1)));
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('roster');
  });
});

describe('checkReadiness: tentative and conflicting answers', () => {
  it('a tentative group answer is not an answer, and the question asks to confirm it', () => {
    let state = trip(['origin']);
    state = put(state, 'mason', 'origin', { city: 'Raleigh' }, 'tentative');
    const result = checkReadiness(state);
    expect(result.missing).toContain('origin');
    expect(result.questions[0].text).toMatch(/confirm/i);
  });

  it.each([
    ['origin', { city: 'Chapel Hill' }, { city: 'Durham' }],
    ['duration', { nights: 2 }, { nights: 3 }],
    ['region', { searchRegion: 'NC mountains' }, { searchRegion: 'NC coast' }],
  ] as const)('different %s positions are a conflict with a targeted question, not a missing slot', (field, a, b) => {
    let state = trip([field]);
    state = put(state, 'mason', field, a as never);
    state = put(state, 'alex', field, b as never);
    state = put(state, 'jordan', field, a as never);
    const result = checkReadiness(state);
    expect(result.ready).toBe(false);
    expect(result.conflicts).toContain(field);
    expect(result.missing).not.toContain(field);
    expect(result.questions[0].text).toMatch(/which/i);
  });

  it('a restated agreement resolves the conflict', () => {
    let state = trip(['duration']);
    state = put(state, 'mason', 'duration', { nights: 2 });
    state = put(state, 'alex', 'duration', { nights: 3 });
    state = put(state, 'jordan', 'duration', { nights: 2 });
    state = put(state, 'alex', 'duration', { nights: 2 });
    expect(checkReadiness(state).ready).toBe(true);
  });

  it('a tentative budget change after a confirmed one asks privately and does not leak to the group', () => {
    const state = put(trip(), 'mason', 'budget', { cents: 15_000 }, 'tentative');
    const result = checkReadiness(state);
    expect(result.ready).toBe(false);
    expect(result.conflicts).toEqual(['budget_unconfirmed:mason']);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].audience).toEqual({ kind: 'private', memberId: 'mason' });
  });

  it('a tentative availability change asks the person privately', () => {
    const state = put(trip(), 'alex', 'availability', { intervals: [OTHER_WEEKEND] }, 'tentative');
    const result = checkReadiness(state);
    expect(result.conflicts).toEqual(['availability_unconfirmed:alex']);
    expect(result.questions[0].audience).toEqual({ kind: 'private', memberId: 'alex' });
  });

  it('a floated must-do is not silently dropped', () => {
    const state = put(trip(), 'jordan', 'must_dos', { items: ['vegetarian food'] }, 'tentative');
    const result = checkReadiness(state);
    expect(result.conflicts).toEqual(['must_dos_unconfirmed:jordan']);
    expect(result.questions[0].audience).toEqual({ kind: 'private', memberId: 'jordan' });
  });
});

describe('checkReadiness: dates', () => {
  it('overlapping windows long enough for the trip are valid', () => {
    let state = trip(['availability']);
    state = put(state, 'mason', 'availability', { intervals: [WEEKEND] });
    state = put(state, 'alex', 'availability', { intervals: [WEEKEND, OTHER_WEEKEND] });
    state = put(state, 'jordan', 'availability', { intervals: [OTHER_WEEKEND, WEEKEND] });
    expect(checkReadiness(state).ready).toBe(true);
  });

  it('disjoint windows are a date conflict that asks which dates are right', () => {
    let state = trip(['availability']);
    state = put(state, 'mason', 'availability', { intervals: [WEEKEND] });
    state = put(state, 'alex', 'availability', { intervals: [OTHER_WEEKEND] });
    state = put(state, 'jordan', 'availability', { intervals: [WEEKEND, OTHER_WEEKEND] });
    const result = checkReadiness(state);
    expect(result.ready).toBe(false);
    expect(result.conflicts).toContain('dates');
    expect(result.questions[0].audience).toEqual({ kind: 'group' });
    expect(result.questions[0].text).toMatch(/which of the dates/i);
  });

  it('an overlap too short for the trip length is a conflict', () => {
    let state = trip(['availability']);
    state = put(state, 'mason', 'availability', { intervals: [WEEKEND] });
    state = put(state, 'alex', 'availability', { intervals: [{ startAt: '2026-10-18T12:00:00.000Z', endAt: '2026-10-18T20:00:00.000Z' }] });
    state = put(state, 'jordan', 'availability', { intervals: [WEEKEND] });
    expect(checkReadiness(state).conflicts).toContain('dates');
  });

  it('the same overlap works for a shorter trip', () => {
    let state = trip(['availability', 'duration']);
    for (const id of members) state = put(state, id, 'duration', { nights: 1 });
    state = put(state, 'mason', 'availability', { intervals: [WEEKEND] });
    state = put(state, 'alex', 'availability', { intervals: [{ startAt: '2026-10-17T12:00:00.000Z', endAt: '2026-10-18T20:00:00.000Z' }] });
    state = put(state, 'jordan', 'availability', { intervals: [WEEKEND] });
    expect(checkReadiness(state).ready).toBe(true);
  });

  it('does not report a date conflict while someone still owes their dates', () => {
    let state = trip(['availability']);
    state = put(state, 'mason', 'availability', { intervals: [WEEKEND] });
    state = put(state, 'alex', 'availability', { intervals: [OTHER_WEEKEND] });
    const result = checkReadiness(state);
    expect(result.conflicts).not.toContain('dates');
    expect(result.missing).toEqual(['availability:jordan']);
  });
});

describe('questions', () => {
  it('asks for a missing budget in the exact words, privately', () => {
    const result = checkReadiness(trip(['budget']));
    expect(BUDGET_QUESTION).toBe("What's your maximum total for this trip, including food and travel?");
    for (const q of result.questions) {
      expect(q.text).toBe(BUDGET_QUESTION);
      expect(q.audience.kind).toBe('private');
    }
  });

  it('asks ONE question at a time, the most basic gap first', () => {
    const result = checkReadiness(createTrip('empty', roster));
    expect(result.questions.length).toBe(MAX_QUESTIONS_PER_TURN);
    // The most basic gap comes first: the trip basics, not tastes or money.
    expect(result.questions.map((q) => q.key)).toEqual(['origin']);
  });

  it('asks people to confirm their consent before anything else', () => {
    const people = roster.map((m) => (m.memberId === 'alex' ? { ...m, consented: false } : m));
    const result = checkReadiness(createTrip('t', people));
    expect(result.questions[0].key).toBe('consent');
  });

  it('never puts a private cap in a group question', () => {
    const states = [trip(['budget']), put(trip(), 'mason', 'budget', { cents: 15_000 }, 'tentative')];
    for (const state of states) {
      for (const q of checkReadiness(state).questions) {
        if (q.audience.kind === 'group') expect(q.text).not.toMatch(/\$|\d{4,}/);
      }
    }
  });

  it('does not repeat a recently asked unanswered question', () => {
    const state = trip(['origin']);
    const first = checkReadiness(state, { now: NOW });
    expect(first.questions.map((q) => q.key)).toEqual(['origin']);

    const asked = recordQuestions(state, first.questions, NOW);
    const soon = new Date(Date.parse(NOW) + 60_000).toISOString();
    const second = checkReadiness(asked, { now: soon });
    // Still missing, but not nagged about.
    expect(second.missing).toContain('origin');
    expect(second.questions).toEqual([]);
  });

  it('asks again once the cooldown has passed', () => {
    const state = trip(['origin']);
    const asked = recordQuestions(state, checkReadiness(state, { now: NOW }).questions, NOW);
    const later = new Date(Date.parse(NOW) + QUESTION_COOLDOWN_MS + 1).toISOString();
    expect(checkReadiness(asked, { now: later }).questions.map((q) => q.key)).toEqual(['origin']);
  });

  it('holds the next question back while the first is unanswered, then moves on once it is answered', () => {
    const state = trip(['origin', 'duration', 'region']);
    const firstTurn = checkReadiness(state, { now: NOW });
    expect(firstTurn.questions.map((q) => q.key)).toEqual(['origin']);
    const asked = recordQuestions(state, firstTurn.questions, NOW);
    // Someone else starting the conversation right now must not unlock a second shared question.
    expect(checkReadiness(asked, { now: NOW }).questions).toEqual([]);
    // Once the answer arrives (origin is set and the open question is forgotten) the next one is asked.
    const answered = put(asked, 'mason', 'origin', { city: 'Chapel Hill' });
    const cleared = clearAnsweredQuestions(answered, openQuestionKeys(answered));
    expect(checkReadiness(cleared, { now: NOW }).questions.map((q) => q.key)).toEqual(['duration']);
  });

  it('asks each person for their own private details one at a time, in parallel, never someone else\'s', () => {
    const state = trip(['availability', 'budget', 'preferences']);
    const keys = checkReadiness(state, { now: NOW }).questions.map((q) => q.key).sort();
    expect(keys).toEqual(['availability:alex', 'availability:jordan', 'availability:mason']); // dates first, one each
    for (const q of checkReadiness(state, { now: NOW }).questions) expect(q.audience.kind).toBe('private');
  });

  it('a shared question open for one person blocks that group question for everyone, but not after the cooldown', () => {
    const state = trip(['origin']);
    const asked = recordQuestions(state, checkReadiness(state, { now: NOW }).questions, NOW);
    expect(checkReadiness(asked, { now: NOW }).questions).toEqual([]);
    const muchLater = new Date(Date.parse(NOW) + 13 * 3_600_000).toISOString();
    expect(checkReadiness(asked, { now: muchLater }).questions.map((q) => q.key)).toEqual(['origin']);
  });

  it('recordQuestions replaces an earlier entry for the same key and leaves the input unchanged', () => {
    const state = trip(['origin']);
    const q = checkReadiness(state).questions;
    const once = recordQuestions(state, q, NOW);
    const twice = recordQuestions(once, q, '2026-10-11T12:00:00.000Z');
    expect(state.pendingQuestions).toEqual([]);
    expect(twice.pendingQuestions).toHaveLength(1);
    expect(twice.pendingQuestions[0].askedAt).toBe('2026-10-11T12:00:00.000Z');
  });

  it('forgets a question once its answer arrives', () => {
    const state = trip(['origin']);
    const asked = recordQuestions(state, checkReadiness(state).questions, NOW);
    expect(asked.pendingQuestions).toHaveLength(1);

    const stillOpen = clearAnsweredQuestions(asked, openQuestionKeys(asked));
    expect(stillOpen).toBe(asked);

    let answered = asked;
    for (const id of members) answered = put(answered, id, 'origin', { city: 'Chapel Hill' });
    expect(clearAnsweredQuestions(answered, openQuestionKeys(answered)).pendingQuestions).toEqual([]);
  });
});

describe('question fields', () => {
  const fieldsOf = (state: TripState) => Object.fromEntries(checkReadiness(state).questions.map((q) => [q.key, q.field]));

  it('maps every key readiness produces to the constraint its answer would set', () => {
    expect(fieldForKey('origin')).toBe('origin');
    expect(fieldForKey('conflict:origin')).toBe('origin');
    expect(fieldForKey('duration')).toBe('duration');
    expect(fieldForKey('conflict:duration')).toBe('duration');
    expect(fieldForKey('region')).toBe('region');
    expect(fieldForKey('conflict:region')).toBe('region');
    expect(fieldForKey('transport')).toBe('transport');
    expect(fieldForKey('conflict:transport')).toBe('transport');
    expect(fieldForKey('vehicle')).toBe('transport');
    expect(fieldForKey('availability')).toBe('availability');
    expect(fieldForKey('conflict:dates')).toBe('availability');
    expect(fieldForKey('availability_unconfirmed:alex')).toBe('availability');
    expect(fieldForKey('budget:alex')).toBe('budget');
    expect(fieldForKey('budget_unconfirmed:alex')).toBe('budget');
    expect(fieldForKey('must_dos_unconfirmed:alex')).toBe('must_dos');
    expect(fieldForKey('preferences')).toBe('preferences');
  });

  it('roster and consent questions set no constraint', () => {
    expect(fieldForKey('consent')).toBeUndefined();
    expect(fieldForKey('roster')).toBeUndefined();
    expect(fieldForKey('something-new')).toBeUndefined();
    const people = roster.map((m) => (m.memberId === 'alex' ? { ...m, consented: false } : m));
    const [q] = checkReadiness(createTrip('t', people)).questions;
    expect(q.key).toBe('consent');
    expect('field' in q).toBe(false);
  });

  it('every question carries the field its key maps to, across the situations readiness covers', () => {
    const states: TripState[] = [
      createTrip('empty', roster),
      trip(['origin', 'duration', 'region', 'transport']),
      trip(['availability']),
      trip(['budget']),
      trip(['preferences']),
      put(trip(), 'mason', 'budget', { cents: 15_000 }, 'tentative'),
      put(trip(), 'alex', 'availability', { intervals: [OTHER_WEEKEND] }, 'tentative'),
      put(trip(), 'jordan', 'must_dos', { items: ['vegetarian food'] }, 'tentative'),
      put(put(trip(['origin']), 'mason', 'origin', { city: 'Raleigh' }), 'alex', 'origin', { city: 'Durham' }),
    ];
    let seen = 0;
    for (const state of states) {
      for (const q of checkReadiness(state).questions) {
        seen += 1;
        expect(q.field).toBe(fieldForKey(q.key));
        expect(q.field).toBeDefined();
      }
    }
    expect(seen).toBeGreaterThan(8);
  });

  it('maps every open key, not just the two asked this turn: only roster and consent have no field', () => {
    const noCar = trip(['transport']);
    let noVehicle = noCar;
    for (const id of members) noVehicle = put(noVehicle, id, 'transport', { mode: 'car', vehicleAvailable: false });
    const disagree = (field: 'duration' | 'region' | 'transport', a: never, b: never) => {
      let state = trip([field]);
      state = put(state, 'mason', field, a);
      state = put(state, 'alex', field, b);
      return put(state, 'jordan', field, a);
    };
    let datesClash = trip(['availability']);
    datesClash = put(datesClash, 'mason', 'availability', { intervals: [WEEKEND] });
    datesClash = put(datesClash, 'alex', 'availability', { intervals: [OTHER_WEEKEND] });
    datesClash = put(datesClash, 'jordan', 'availability', { intervals: [WEEKEND] });
    const people = roster.map((m) => (m.memberId === 'alex' ? { ...m, consented: false } : m));
    const states: TripState[] = [
      createTrip('empty', roster),
      createTrip('waiting', people),
      createTrip('alone', roster.slice(0, 1)),
      noVehicle,
      disagree('duration', { nights: 2 } as never, { nights: 3 } as never),
      disagree('region', { searchRegion: 'NC mountains' } as never, { searchRegion: 'NC coast' } as never),
      disagree('transport', { mode: 'car', vehicleAvailable: true } as never, { mode: 'car', vehicleAvailable: false } as never),
      datesClash,
      put(trip(), 'alex', 'availability', { intervals: [OTHER_WEEKEND] }, 'tentative'),
      put(trip(), 'mason', 'budget', { cents: 15_000 }, 'tentative'),
      put(trip(), 'jordan', 'must_dos', { items: ['vegetarian food'] }, 'tentative'),
      trip(['preferences']),
    ];
    const keys = new Set(states.flatMap((state) => [...openQuestionKeys(state)]));
    for (const wanted of ['consent', 'roster', 'vehicle', 'conflict:duration', 'conflict:region', 'conflict:transport', 'conflict:dates', 'availability_unconfirmed:alex', 'budget_unconfirmed:mason', 'must_dos_unconfirmed:jordan', 'preferences:mason', 'availability:mason', 'origin']) {
      expect(keys).toContain(wanted);
    }
    for (const key of keys) {
      if (key === 'consent' || key === 'roster') expect(fieldForKey(key)).toBeUndefined();
      else expect(fieldForKey(key), `no field for ${key}`).toBeDefined();
    }
  });

  it('reports the right field for the specific situations, public and private', () => {
    expect(fieldsOf(trip(['budget']))).toMatchObject({ 'budget:mason': 'budget' });
    expect(fieldsOf(put(trip(), 'mason', 'budget', { cents: 15_000 }, 'tentative'))).toEqual({ 'budget_unconfirmed:mason': 'budget' });
    expect(fieldsOf(put(trip(), 'jordan', 'must_dos', { items: ['vegetarian food'] }, 'tentative'))).toEqual({ 'must_dos_unconfirmed:jordan': 'must_dos' });
    expect(fieldsOf(put(put(trip(['origin']), 'mason', 'origin', { city: 'Raleigh' }), 'alex', 'origin', { city: 'Durham' }))).toEqual({ 'conflict:origin': 'origin' });
  });

  it('a recorded pending question keeps its field, so a later short reply can be read against it', () => {
    const state = trip(['budget']);
    const asked = recordQuestions(state, checkReadiness(state).questions, NOW);
    expect(asked.pendingQuestions.map((q) => [q.key, q.field])).toEqual([
      ['budget:mason', 'budget'],
      ['budget:alex', 'budget'],
      ['budget:jordan', 'budget'],
    ]);
    const group = recordQuestions(createTrip('t', roster), checkReadiness(createTrip('t', roster)).questions, NOW);
    expect(group.pendingQuestions.every((q) => q.field !== undefined)).toBe(true);
    const consent = roster.map((m) => (m.memberId === 'alex' ? { ...m, consented: false } : m));
    const noField = recordQuestions(createTrip('t', consent), checkReadiness(createTrip('t', consent)).questions, NOW);
    expect('field' in noField.pendingQuestions[0]).toBe(false);
  });
});
