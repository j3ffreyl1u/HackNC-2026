import { describe, expect, it } from 'vitest';
import { QUESTION_COOLDOWN_MS, recordQuestions } from '../../src/planning/questions.js';
import { checkReadiness, outstandingForOthers } from '../../src/planning/readiness.js';
import { createTrip } from '../../src/planning/state.js';
import type { TripState } from '../../src/planning/types.js';
import { NOW, WEEKEND, ids, put, roster } from './fixtures.js';

const empty = () => createTrip('trip-1', roster);
/** One person has given the shared basics, so the other two have only been asked whether the plan so far works. */
function basicsFromMason(): TripState {
  let s = empty();
  s = put(s, 'mason', 'origin', { city: 'Chapel Hill' });
  s = put(s, 'mason', 'duration', { nights: 2 });
  s = put(s, 'mason', 'region', { searchRegion: 'NC mountains', maxTravelMinutes: 240 });
  s = put(s, 'mason', 'transport', { mode: 'car', vehicleAvailable: true });
  return s;
}
const giveEverything = (s: TripState, id: string, cap = 20_000) => {
  s = put(s, id, 'availability', { intervals: [WEEKEND] });
  s = put(s, id, 'budget', { cents: cap });
  return put(s, id, 'preferences', { items: ['hiking'] });
};
const ask = (state: TripState, actorId: string, now = NOW) => checkReadiness(state, { now, actorId }).questions;

describe('who is asked what while people talk at the same time', () => {
  it('asks the person talking the next shared question, and only one question', () => {
    const questions = ask(empty(), 'mason');
    expect(questions).toHaveLength(1);
    expect(questions[0]!.key).toBe('origin');
    expect(questions[0]!.audience.kind).toBe('group');
  });

  it('gives the second person their OWN next question while the shared one is held by someone else', () => {
    const first = ask(empty(), 'mason');
    const state = recordQuestions(empty(), first, NOW);
    const second = ask(state, 'alex');
    expect(second).toHaveLength(1);
    expect(second[0]!.audience).toEqual({ kind: 'private', memberId: 'alex' });
    expect(second[0]!.key).toBe('availability:alex');
  });

  it('never asks anyone a private question while somebody else is the one talking', () => {
    for (const talker of ids) {
      for (const q of ask(basicsFromMason(), talker)) {
        if (q.audience.kind === 'private') expect(q.audience.memberId).toBe(talker);
      }
    }
  });

  it('asks the person talking the sign-off question about the shared basics before their own details', () => {
    const questions = ask(basicsFromMason(), 'alex');
    expect(questions).toHaveLength(1);
    expect(questions[0]!.key).toBe('confirm_basics:alex');
  });

  it('tells everyone about a disagreement straight away, even while a shared question is open', () => {
    let s = empty();
    s = put(s, 'mason', 'origin', { city: 'Raleigh' });
    s = put(s, 'alex', 'origin', { city: 'Durham' });
    const open = recordQuestions(s, [{ audience: { kind: 'group' }, text: 'Something else is open', key: 'duration' }], NOW);
    const questions = ask(open, 'jordan');
    expect(questions.map((q) => q.key)).toContain('conflict:origin');
    expect(questions.find((q) => q.key === 'conflict:origin')!.audience.kind).toBe('group');
  });

  it('does not repeat a question inside the cooldown, and asks again after it', () => {
    const state = recordQuestions(empty(), ask(empty(), 'mason'), NOW);
    const soon = new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString();
    expect(ask(state, 'mason', soon).map((q) => q.key)).not.toContain('origin');
    const later = new Date(Date.parse(NOW) + QUESTION_COOLDOWN_MS + 1000).toISOString();
    expect(ask(state, 'mason', later).map((q) => q.key)).toContain('origin');
  });

  it('asks nothing of a talker with nothing left to ask', () => {
    let s = basicsFromMason();
    for (const id of ids) s = giveEverything(s, id);
    s = put(put(s, 'alex', 'origin', { city: 'Chapel Hill' }), 'jordan', 'origin', { city: 'Chapel Hill' });
    s = put(put(s, 'alex', 'duration', { nights: 2 }), 'jordan', 'duration', { nights: 2 });
    s = put(put(s, 'alex', 'region', { searchRegion: 'NC mountains', maxTravelMinutes: 240 }), 'jordan', 'region', { searchRegion: 'NC mountains', maxTravelMinutes: 240 });
    s = put(put(s, 'alex', 'transport', { mode: 'car', vehicleAvailable: true }), 'jordan', 'transport', { mode: 'car', vehicleAvailable: true });
    expect(ask(s, 'mason')).toEqual([]);
  });
});

describe('outstandingForOthers: who the planner can nudge, and what they owe', () => {
  it('lists the other people with what each still owes, in plain words and with their own next question', () => {
    const owed = outstandingForOthers(basicsFromMason(), 'mason');
    expect(owed.map((o) => o.memberId)).toEqual(['alex', 'jordan']);
    for (const o of owed) {
      expect(o.items).toEqual(['dates', 'budget', 'preferences']);
      expect(o.question.audience).toEqual({ kind: 'private', memberId: o.memberId });
      expect(o.question.key).toBe(`confirm_basics:${o.memberId}`);
    }
  });

  it('never lists the person asking, or anyone who owes nothing', () => {
    let s = giveEverything(basicsFromMason(), 'alex');
    s = put(put(put(s, 'alex', 'origin', { city: 'Chapel Hill' }), 'alex', 'duration', { nights: 2 }), 'alex', 'region', { searchRegion: 'NC mountains', maxTravelMinutes: 240 });
    s = put(s, 'alex', 'transport', { mode: 'car', vehicleAvailable: true });
    const owed = outstandingForOthers(s, 'mason');
    expect(owed.map((o) => o.memberId)).toEqual(['jordan']);
    expect(outstandingForOthers(s, 'jordan').map((o) => o.memberId)).not.toContain('jordan');
  });

  it('names the plan sign-off only when it is the one thing missing', () => {
    let s = basicsFromMason();
    for (const id of ['alex', 'jordan']) s = giveEverything(s, id);
    const owed = outstandingForOthers(s, 'mason');
    expect(owed.map((o) => [o.memberId, o.items])).toEqual([['alex', ['OK on the plan so far']], ['jordan', ['OK on the plan so far']]]);
  });

  it('carries no amounts, only what is owed', () => {
    let s = basicsFromMason();
    s = put(s, 'mason', 'budget', { cents: 13_700 });
    const owed = outstandingForOthers(s, 'alex');
    expect(JSON.stringify(owed)).not.toMatch(/137|13700|\$/);
    expect(owed.map((o) => o.memberId)).not.toContain('alex');
  });

  it('is empty when nobody else owes anything', () => {
    let s = basicsFromMason();
    for (const id of ids) s = giveEverything(s, id);
    s = put(put(s, 'alex', 'origin', { city: 'Chapel Hill' }), 'jordan', 'origin', { city: 'Chapel Hill' });
    s = put(put(s, 'alex', 'duration', { nights: 2 }), 'jordan', 'duration', { nights: 2 });
    s = put(put(s, 'alex', 'region', { searchRegion: 'NC mountains', maxTravelMinutes: 240 }), 'jordan', 'region', { searchRegion: 'NC mountains', maxTravelMinutes: 240 });
    s = put(put(s, 'alex', 'transport', { mode: 'car', vehicleAvailable: true }), 'jordan', 'transport', { mode: 'car', vehicleAvailable: true });
    expect(outstandingForOthers(s, 'mason')).toEqual([]);
  });
});
