import { describe, expect, it } from 'vitest';
import { applyCommand, installCandidates } from '../../src/planning/commands.js';
import { createTrip } from '../../src/planning/state.js';
import type { ApplyResult, TripAction, TripState } from '../../src/planning/types.js';
import { NOW, candidate, command, ids, put, readyState, roster, update } from './fixtures.js';

const run = (state: TripState, actor: string, action: TripAction): ApplyResult => applyCommand(state, command(actor, action), { now: NOW });
const setCap = (state: TripState, actor: string, cents: number, certainty: 'confirmed' | 'tentative' = 'confirmed') =>
  run(state, actor, { kind: 'update_constraint', update: update(actor, 'budget', { cents }, certainty) });
const publicText = (r: ApplyResult) => r.replies.filter((x) => x.audience.kind === 'group').map((x) => x.text).join(' ');

/** Ready trip with the two fixture options researched at revision 1: A upper 19,000 each, B upper 18,000 each. */
function proposed(): TripState {
  const result = installCandidates(readyState(), 1, [candidate('a', 48_000, ['hiking']), candidate('b', 45_000, ['hiking', 'town visit'])]);
  return result.state;
}
function allAccept(state: TripState, candidateId: string): TripState {
  let s = run(state, 'mason', { kind: 'select_candidate', candidateId, revision: state.revision }).state;
  for (const id of ids) s = run(s, id, { kind: 'accept_candidate', candidateId, revision: s.revision }).state;
  return s;
}

describe('request_plans', () => {
  it('starts research when the trip is ready', () => {
    const result = run(readyState(), 'mason', { kind: 'request_plans' });
    expect(result.rejection).toBeUndefined();
    expect(result.researchRequested).toBe(true);
    expect(result.state.status).toBe('researching');
    expect(result.state.revision).toBe(1);
  });

  it('refuses with NOT_READY and asks the specific question when something is missing', () => {
    const state = createTrip('trip-1', roster);
    const result = run(state, 'mason', { kind: 'request_plans' });
    expect(result.rejection?.code).toBe('NOT_READY');
    expect(result.researchRequested).toBe(false);
    expect(result.state.status).toBe('gathering');
    expect(result.replies[0].text).toMatch(/leaving from/i);
  });

  it('does not ask the same unanswered question twice in a row', () => {
    const first = run(createTrip('trip-1', roster), 'mason', { kind: 'request_plans' });
    const second = run(first.state, 'alex', { kind: 'request_plans' });
    const askedAgain = second.replies.some((r) => first.replies.some((f) => f.text === r.text));
    expect(askedAgain).toBe(false);
  });

  it('is refused for an approved trip', () => {
    const approved = allAccept(proposed(), 'b');
    expect(run(approved, 'mason', { kind: 'request_plans' }).rejection?.code).toBe('AMBIGUOUS_ACTION');
  });
});

describe('who may act', () => {
  it('ignores strangers and people who have not consented, leaving state unchanged', () => {
    const state = proposed();
    const stranger = run(state, 'casey', { kind: 'request_plans' });
    expect(stranger.rejection?.code).toBe('UNKNOWN_MEMBER');
    expect(stranger.state).toBe(state);

    const waiting = { ...state, roster: state.roster.map((m) => (m.memberId === 'alex' ? { ...m, consented: false } : m)) };
    expect(run(waiting, 'alex', { kind: 'accept_candidate', candidateId: 'b', revision: 1 }).rejection?.code).toBe('UNKNOWN_MEMBER');
  });

  it('rejects a command for another trip', () => {
    const result = applyCommand(proposed(), command('mason', { kind: 'request_plans' }, 'other-trip'), { now: NOW });
    expect(result.rejection?.code).toBe('AMBIGUOUS_ACTION');
  });

  it('one person cannot change another person’s cap', () => {
    const state = proposed();
    const result = run(state, 'alex', { kind: 'update_constraint', update: update('mason', 'budget', { cents: 1_000 }) });
    expect(result.rejection?.code).toBe('INVALID_CONSTRAINT');
    expect(result.state).toBe(state);
  });

  it('a rejection is a private reply to the actor and leaves everything unchanged', () => {
    const state = proposed();
    const result = run(state, 'alex', { kind: 'select_candidate', candidateId: 'zzz', revision: 1 });
    expect(result.state).toBe(state);
    expect(result.replies).toEqual([{ audience: { kind: 'private', memberId: 'alex' }, text: result.rejection?.userMessage }]);
  });
});

describe('select and accept', () => {
  it('selecting an option asks everyone to accept and does not accept anyone', () => {
    const result = run(proposed(), 'mason', { kind: 'select_candidate', candidateId: 'b', revision: 1 });
    expect(result.state).toMatchObject({ status: 'awaiting_acceptance', selectedCandidateId: 'b', acceptances: [] });
    expect(result.replies[0]).toMatchObject({ audience: { kind: 'group' }, proposalRef: { candidateId: 'b', revision: 1 } });
    expect(result.replies[0].text).toMatch(/each of you needs to accept/);
  });

  it('approval needs every participant; silence is not acceptance', () => {
    let s = run(proposed(), 'mason', { kind: 'select_candidate', candidateId: 'b', revision: 1 }).state;
    s = run(s, 'mason', { kind: 'accept_candidate', candidateId: 'b', revision: 1 }).state;
    const two = run(s, 'alex', { kind: 'accept_candidate', candidateId: 'b', revision: 1 });
    expect(two.state.status).toBe('awaiting_acceptance');
    expect(publicText(two)).toContain('Still waiting on Jordan');
    const three = run(two.state, 'jordan', { kind: 'accept_candidate', candidateId: 'b', revision: 1 });
    expect(three.state.status).toBe('approved');
    expect(publicText(three)).toMatch(/nothing is booked/);
  });

  it('accepting twice records one acceptance', () => {
    let s = run(proposed(), 'mason', { kind: 'select_candidate', candidateId: 'b', revision: 1 }).state;
    s = run(s, 'mason', { kind: 'accept_candidate', candidateId: 'b', revision: 1 }).state;
    const again = run(s, 'mason', { kind: 'accept_candidate', candidateId: 'b', revision: 1 });
    expect(again.state.acceptances).toHaveLength(1);
    expect(again.replies).toEqual([]);
  });

  it('an acceptance for a stale revision does nothing', () => {
    const s = run(proposed(), 'mason', { kind: 'select_candidate', candidateId: 'b', revision: 1 }).state;
    const result = run(s, 'alex', { kind: 'accept_candidate', candidateId: 'b', revision: 0 });
    expect(result.rejection?.code).toBe('STALE_REVISION');
    expect(result.state).toBe(s);
  });

  it('accepting an option that is not the one up for approval does nothing', () => {
    const s = run(proposed(), 'mason', { kind: 'select_candidate', candidateId: 'b', revision: 1 }).state;
    expect(run(s, 'alex', { kind: 'accept_candidate', candidateId: 'a', revision: 1 }).rejection?.code).toBe('AMBIGUOUS_ACTION');
    // Nothing has been selected yet:
    expect(run(proposed(), 'alex', { kind: 'accept_candidate', candidateId: 'b', revision: 1 }).rejection?.code).toBe('AMBIGUOUS_ACTION');
  });

  it('cannot select an infeasible or unpriced option', () => {
    const tight = installCandidates(readyState({ mason: 18_000, alex: 25_000, jordan: 30_000 }), 1, [candidate('a', 48_000), candidate('b', 45_000)]).state;
    expect(run(tight, 'mason', { kind: 'select_candidate', candidateId: 'a', revision: 1 }).rejection?.code).toBe('INFEASIBLE_PLAN');
    expect(run(tight, 'mason', { kind: 'select_candidate', candidateId: 'b', revision: 1 }).rejection).toBeUndefined();

    const unpriced = candidate('u', 30_000);
    unpriced.costs.push({ ...unpriced.costs[0], costId: 'gas', priceStatus: 'unknown', lowCents: 0, highCents: 0 });
    const state = installCandidates(readyState(), 1, [unpriced]).state;
    expect(run(state, 'mason', { kind: 'select_candidate', candidateId: 'u', revision: 1 }).rejection?.code).toBe('INFEASIBLE_PLAN');
  });

  it('selecting a different option clears acceptances for the first', () => {
    let s = run(proposed(), 'mason', { kind: 'select_candidate', candidateId: 'a', revision: 1 }).state;
    s = run(s, 'mason', { kind: 'accept_candidate', candidateId: 'a', revision: 1 }).state;
    s = run(s, 'alex', { kind: 'select_candidate', candidateId: 'b', revision: 1 }).state;
    expect(s.acceptances).toEqual([]);
    expect(s.selectedCandidateId).toBe('b');
  });

  it('cannot select before there are options', () => {
    expect(run(readyState(), 'mason', { kind: 'select_candidate', candidateId: 'a', revision: 1 }).rejection?.code).toBe('AMBIGUOUS_ACTION');
  });
});

describe('the revision story: Mason lowers their cap', () => {
  it('both options start feasible at 19,000 and 18,000 per person', () => {
    const [a, b] = proposed().candidates;
    expect(a.perPersonTotals.map((t) => t.highCents)).toEqual([19_000, 19_000, 19_000]);
    expect(b.perPersonTotals.map((t) => t.highCents)).toEqual([18_000, 18_000, 18_000]);
    expect([a.feasibility.feasible, b.feasibility.feasible]).toEqual([true, true]);
  });

  it('rejects the expensive option, invalidates the approval and asks for acceptance of the new revision', () => {
    const approvedA = allAccept(proposed(), 'a');
    expect(approvedA.status).toBe('approved');

    const result = setCap(approvedA, 'mason', 18_000);
    expect(result.rejection).toBeUndefined();
    expect(result.state.revision).toBe(2);
    expect(result.state.acceptances).toEqual([]);
    expect(result.state.candidates.find((c) => c.candidateId === 'a')?.feasibility.feasible).toBe(false);
    expect(result.state.candidates.find((c) => c.candidateId === 'b')?.feasibility.feasible).toBe(true);
    expect(result.state.selectedCandidateId).toBeUndefined();
    expect(result.state.status).toBe('proposed');
    expect(publicText(result)).toMatch(/Option a no longer fits/);
    expect(publicText(result)).toMatch(/Earlier approvals no longer apply/);
  });

  it('never reveals the cap or who changed it in the group message', () => {
    const result = setCap(allAccept(proposed(), 'a'), 'mason', 18_000);
    const text = publicText(result);
    expect(text).toMatch(/revision 2/);
    expect(text).not.toMatch(/Mason|18,?000|\$/);
  });

  it('the cheaper selected option stays selected but must be accepted again by all', () => {
    const approvedB = allAccept(proposed(), 'b');
    const result = setCap(approvedB, 'mason', 18_000);
    expect(result.state).toMatchObject({ revision: 2, status: 'awaiting_acceptance', selectedCandidateId: 'b', acceptances: [] });
    expect(result.replies[0].proposalRef).toEqual({ candidateId: 'b', revision: 2 });

    // The old acceptance, for revision 1, does nothing now:
    expect(run(result.state, 'alex', { kind: 'accept_candidate', candidateId: 'b', revision: 1 }).rejection?.code).toBe('STALE_REVISION');

    let s = result.state;
    for (const id of ids) s = run(s, id, { kind: 'accept_candidate', candidateId: 'b', revision: 2 }).state;
    expect(s.status).toBe('approved');
    expect(s.acceptances.every((a) => a.revision === 2)).toBe(true);
  });

  it('when nothing fits any more, it asks for new research instead of claiming the caps allow it', () => {
    const result = setCap(proposed(), 'mason', 10_000);
    expect(result.state.candidates.every((c) => !c.feasibility.feasible)).toBe(true);
    expect(result.state.status).toBe('researching');
    expect(result.researchRequested).toBe(true);
    expect(publicText(result)).not.toMatch(/\$|10,?000/);
  });

  it('a tentative lowering changes nothing yet but asks to confirm, privately', () => {
    const state = proposed();
    const result = setCap(state, 'mason', 18_000, 'tentative');
    expect(result.state.revision).toBe(1);
    expect(result.state.candidates).toEqual(state.candidates);
    const ask = result.replies.find((r) => r.audience.kind === 'private');
    expect(ask?.audience).toEqual({ kind: 'private', memberId: 'mason' });
  });

  it('restating the same cap is not a change', () => {
    const state = proposed();
    expect(setCap(state, 'mason', 20_000).state.revision).toBe(1);
  });

  it('raising a cap is a change too: the approved plan must be re-approved', () => {
    const result = setCap(allAccept(proposed(), 'b'), 'jordan', 40_000);
    expect(result.state.revision).toBe(2);
    expect(result.state.acceptances).toEqual([]);
  });
});

describe('other material changes', () => {
  it('changed dates re-check candidates against the new window', () => {
    const state = proposed();
    const moved = { startAt: '2026-10-23T17:00:00.000Z', endAt: '2026-10-25T20:00:00.000Z' };
    const result = run(state, 'jordan', { kind: 'update_constraint', update: update('jordan', 'availability', { intervals: [moved] }) });
    expect(result.state.revision).toBe(2);
    expect(result.state.candidates.every((c) => !c.feasibility.feasible)).toBe(true);
    expect(publicText(result)).toMatch(/Jordan's available dates changed/);
  });

  it('a changed trip length is a group change', () => {
    let s = proposed();
    for (const id of ids) s = run(s, id, { kind: 'update_constraint', update: update(id, 'duration', { nights: 3 }) }).state;
    expect(s.revision).toBeGreaterThan(1);
    expect(s.candidates.every((c) => !c.feasibility.feasible)).toBe(true);
  });

  it('a soft preference change records without voiding the plan', () => {
    const state = proposed();
    const result = run(state, 'alex', { kind: 'update_constraint', update: update('alex', 'preferences', { items: ['breweries'] }) });
    expect(result.state.revision).toBe(1);
    expect(result.state.memberConstraints.alex).toHaveLength(state.memberConstraints.alex.length + 1);
  });

  it('a confirmed must-do the plan lacks drops the options', () => {
    const result = run(proposed(), 'alex', { kind: 'update_constraint', update: update('alex', 'must_dos', { items: ['waterfall'] }) });
    expect(result.state.revision).toBe(2);
    expect(result.state.candidates.every((c) => !c.feasibility.feasible)).toBe(true);
  });

  it('invalid updates are rejected without changing state', () => {
    const state = proposed();
    const result = setCap(state, 'mason', -5);
    expect(result.rejection?.code).toBe('INVALID_CONSTRAINT');
    expect(result.state).toBe(state);
  });

  it('while gathering, an update bumps nothing visible to the group but asks the next question', () => {
    const state = createTrip('trip-1', roster);
    const result = run(state, 'mason', { kind: 'update_constraint', update: update('mason', 'origin', { city: 'Chapel Hill' }) });
    expect(result.state.status).toBe('gathering');
    expect(result.researchRequested).toBe(false);
    expect(result.replies.length).toBeGreaterThan(0);
    expect(result.replies.length).toBeLessThanOrEqual(2);
  });

  it('a change while research is running restarts research at the new revision when ready', () => {
    const researching = run(readyState(), 'mason', { kind: 'request_plans' }).state;
    const result = setCap(researching, 'mason', 15_000);
    expect(result.state.revision).toBe(2);
    expect(result.researchRequested).toBe(true);
    expect(result.state.status).toBe('researching');
  });
});

describe('installCandidates', () => {
  it('installs candidates researched at the current revision, priced against current constraints', () => {
    const result = installCandidates(readyState(), 1, [candidate('a', 48_000), candidate('b', 45_000)]);
    expect(result.state.status).toBe('proposed');
    expect(result.state.candidates.map((c) => c.revision)).toEqual([1, 1]);
  });

  it('discards research computed for an older revision and keeps the newer state', () => {
    const newer = setCap(proposed(), 'mason', 18_000).state;
    const result = installCandidates(newer, 1, [candidate('a', 48_000)]);
    expect(result.rejection?.code).toBe('STALE_REVISION');
    expect(result.state).toBe(newer);
  });

  it('with nothing feasible the trip stays gathering and has nothing to select', () => {
    const tight = readyState({ mason: 5_000, alex: 5_000, jordan: 5_000 });
    const result = installCandidates(tight, 1, [candidate('a', 48_000)]);
    expect(result.state.status).toBe('gathering');
    expect(result.state.selectedCandidateId).toBeUndefined();
  });

  it('new candidates void any earlier acceptance', () => {
    const approved = allAccept(proposed(), 'b');
    const result = installCandidates(approved, approved.revision, [candidate('c', 40_000)]);
    expect(result.state.acceptances).toEqual([]);
    expect(result.state.status).toBe('proposed');
  });
});

describe('guide and funding', () => {
  it('a guide question never changes the plan', () => {
    const state = allAccept(proposed(), 'b');
    const result = run(state, 'mason', { kind: 'ask_guide', question: "It's raining, what can we do?" });
    expect(result.state).toBe(state);
    expect(result.rejection).toBeUndefined();
  });

  it('funding is refused until a plan is approved', () => {
    expect(run(proposed(), 'mason', { kind: 'request_funding' }).rejection?.code).toBe('MISSING_APPROVAL');
    const approved = allAccept(proposed(), 'b');
    const ok = run(approved, 'mason', { kind: 'request_funding' });
    expect(ok.rejection).toBeUndefined();
    expect(ok.state).toBe(approved);
  });
});

describe('purity', () => {
  it('never mutates its input', () => {
    const state = allAccept(proposed(), 'a');
    const snapshot = structuredClone(state);
    setCap(state, 'mason', 18_000);
    expect(state).toEqual(snapshot);
  });
});
