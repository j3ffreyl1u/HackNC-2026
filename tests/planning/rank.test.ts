import { describe, expect, it } from 'vitest';
import { reprice } from '../../src/planning/budget.js';
import { describeCandidate, explainRanking, groupPreferences, rankCandidates } from '../../src/planning/rank.js';
import type { TripCandidate } from '../../src/planning/types.js';
import { candidate, ids, put, readyState } from './fixtures.js';

const state = readyState();
const priced = (c: TripCandidate) => reprice(state, c);

describe('groupPreferences', () => {
  it('lists each stated preference once and drops "no preference"', () => {
    let s = readyState();
    s = put(s, 'mason', 'preferences', { items: ['Hiking', 'breweries'] });
    s = put(s, 'alex', 'preferences', { items: ['no preference'] });
    expect(groupPreferences(s)).toEqual(['Hiking', 'breweries', 'town visit']);
  });
});

describe('rankCandidates', () => {
  it('prefers more satisfied preferences over a lower price', () => {
    const cheap = priced(candidate('cheap', 30_000, ['hiking']));
    const rich = priced(candidate('rich', 48_000, ['hiking', 'town visit']));
    expect(rankCandidates(state, [cheap, rich]).map((r) => r.candidate.candidateId)).toEqual(['rich', 'cheap']);
  });

  it('breaks a preference tie with the lower upper cost', () => {
    const a = priced(candidate('a', 48_000));
    const b = priced(candidate('b', 45_000));
    expect(rankCandidates(state, [a, b]).map((r) => r.candidate.candidateId)).toEqual(['b', 'a']);
  });

  it('breaks a cost tie with the shorter drive', () => {
    const far = priced(candidate('far', 45_000));
    const near = priced(candidate('near', 45_000));
    near.itinerary[0].travelMinutesFromPrevious = 90;
    expect(rankCandidates(state, [far, near]).map((r) => r.candidate.candidateId)).toEqual(['near', 'far']);
  });

  it('is deterministic whatever order candidates arrive in', () => {
    const list = ['c', 'a', 'b'].map((id) => priced(candidate(id, 45_000)));
    const forward = rankCandidates(state, list).map((r) => r.candidate.candidateId);
    const backward = rankCandidates(state, [...list].reverse()).map((r) => r.candidate.candidateId);
    expect(forward).toEqual(['a', 'b', 'c']);
    expect(backward).toEqual(forward);
  });

  it('never ranks an infeasible candidate, however well it matches', () => {
    const tight = readyState({ mason: 18_000, alex: 25_000, jordan: 30_000 });
    const over = reprice(tight, candidate('over', 48_000, ['hiking', 'town visit']));
    const fits = reprice(tight, candidate('fits', 45_000, ['hiking']));
    expect(rankCandidates(tight, [over, fits]).map((r) => r.candidate.candidateId)).toEqual(['fits']);
  });

  it('never ranks a candidate with an unknown essential price', () => {
    const c = candidate('gas', 30_000);
    c.costs.push({ ...c.costs[0], costId: 'gas', priceStatus: 'unknown', lowCents: 0, highCents: 0 });
    expect(rankCandidates(state, [priced(c)])).toEqual([]);
  });

  it('is not swayed by how many people would like it: only stated preferences count', () => {
    const [ranked] = rankCandidates(state, [priced(candidate('a', 45_000, ['hiking']))]);
    expect(ranked.matchedPreferences).toEqual(['hiking']);
    expect(ranked.unmatchedPreferences).toEqual(['town visit']);
  });
});

describe('describeCandidate', () => {
  it('reports the upper total and drive time', () => {
    const d = describeCandidate(state, priced(candidate('a', 48_000)));
    expect(d.upperTotalCents).toBe(19_000 * ids.length);
    expect(d.travelMinutes).toBe(180);
  });
});

describe('explainRanking', () => {
  it('states observable tradeoffs, without scores or percentages', () => {
    const a = priced(candidate('a', 48_000));
    const b = priced(candidate('b', 45_000));
    const text = explainRanking(rankCandidates(state, [a, b])).join(' ');
    expect(text).toContain('Option b');
    expect(text).toContain('$30.00 less across the group');
    expect(text).toContain('town visit');
    expect(text).not.toMatch(/%|score/);
  });

  it('is empty when nothing is feasible', () => {
    expect(explainRanking([])).toEqual([]);
  });
});
