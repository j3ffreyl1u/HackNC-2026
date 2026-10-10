import { describe, expect, it } from 'vitest';
import { applyCommand, installCandidates } from '../../src/planning/commands.js';
import type { TripState } from '../../src/planning/types.js';
import { NOW, candidate, command, ids, readyState } from './fixtures.js';

/** Two candidates, each with an unknown "Gas" (shared) and "Parking" (personal) cost, at revision 1. */
function withUnknownCosts(): TripState {
  const a = candidate('a', 45_000);
  a.costs.push({ costId: 'gas', category: 'fuel_parking_tolls', label: 'Gas', lowCents: 0, highCents: 0, allocation: 'equal_shared', evidenceIds: [], priceStatus: 'unknown' });
  for (const id of ids) {
    a.costs.push({ costId: `parking-${id}`, category: 'fuel_parking_tolls', label: 'Parking', lowCents: 0, highCents: 0, allocation: 'personal', memberId: id, evidenceIds: [], priceStatus: 'unknown' });
  }
  const b = candidate('b', 40_000);
  b.costs.push({ costId: 'gas', category: 'fuel_parking_tolls', label: 'gas', lowCents: 0, highCents: 0, allocation: 'equal_shared', evidenceIds: [], priceStatus: 'unknown' });
  return installCandidates(readyState(), 1, [a, b]).state;
}

const provide = (state: TripState, actor: string, label: string, cents: number, scope: 'shared' | 'personal') =>
  applyCommand(state, command(actor, { kind: 'provide_cost', label, cents, scope }), { now: NOW });

describe('provide_cost: filling in a shared unknown', () => {
  it('fills the matching unknown item on every candidate at the current revision, case-insensitively', () => {
    const state = withUnknownCosts();
    const result = provide(state, 'mason', 'Gas', 5_000, 'shared');
    expect(result.rejection).toBeUndefined();
    for (const c of result.state.candidates) {
      const gas = c.costs.find((x) => x.costId === 'gas');
      expect(gas).toMatchObject({ lowCents: 5_000, highCents: 5_000, priceStatus: 'estimate' });
    }
  });

  it('records who supplied it as a stated amount, with no invented evidence', () => {
    const result = provide(withUnknownCosts(), 'mason', 'Gas', 5_000, 'shared');
    const [a] = result.state.candidates;
    const gas = a.costs.find((x) => x.costId === 'gas');
    expect(gas?.evidenceIds).toEqual([]);
    expect(a.tradeoffs.join(' ')).toMatch(/Gas: Mason said \$50\.00, not an independently verified source\./);
  });

  it('reprices and can turn a candidate newly feasible, reporting that by title', () => {
    const state = withUnknownCosts();
    const before = state.candidates.find((c) => c.candidateId === 'a');
    expect(before?.feasibility.feasible).toBe(false);
    const result = provide(state, 'mason', 'Gas', 3_000, 'shared');
    const after = result.state.candidates.find((c) => c.candidateId === 'a');
    expect(after?.costs.find((c) => c.costId === 'gas')?.priceStatus).toBe('estimate');
    expect(after?.feasibility.unknownEssentials).not.toContain('gas');
    // the personal "Parking" costs are still unknown, so the candidate still isn't fully feasible
    expect(after?.feasibility.unknownEssentials.some((id) => id.startsWith('parking-'))).toBe(true);
    expect(after?.feasibility.feasible).toBe(false);
    // candidate "b" has no personal unknowns, so filling gas makes it fully feasible and gets named.
    expect(result.replies[0].text).toMatch(/Option b now fits everyone's limits/);
  });

  it('moves the trip from gathering to proposed once something becomes fully feasible', () => {
    const state = withUnknownCosts();
    const onlyGas = state.candidates.map((c) => ({ ...c, costs: c.costs.filter((x) => x.allocation !== 'personal' || x.priceStatus !== 'unknown') }));
    const reinstalled = installCandidates(state, state.revision, onlyGas).state;
    expect(reinstalled.status).toBe('gathering'); // nothing feasible yet (gas still unknown)
    const result = provide(reinstalled, 'alex', 'Gas', 1_000, 'shared');
    expect(result.state.status).toBe('proposed');
    expect(result.replies[0].text).toMatch(/now fits everyone's limits/);
  });
});

describe('provide_cost: personal scope applies to every participant equally', () => {
  it('fills every participant’s matching personal item with the same amount', () => {
    const result = provide(withUnknownCosts(), 'jordan', 'Parking', 1_200, 'personal');
    const a = result.state.candidates.find((c) => c.candidateId === 'a');
    const parking = a?.costs.filter((x) => x.costId.startsWith('parking-'));
    expect(parking?.every((x) => x.lowCents === 1_200 && x.highCents === 1_200 && x.priceStatus === 'estimate')).toBe(true);
    expect(parking).toHaveLength(ids.length);
  });

  it('does not touch a shared cost of the same label, and vice versa', () => {
    const shared = provide(withUnknownCosts(), 'mason', 'Gas', 4_000, 'shared').state;
    const stillPersonalUnknown = shared.candidates[0].costs.filter((c) => c.costId.startsWith('parking-'));
    expect(stillPersonalUnknown.every((c) => c.priceStatus === 'unknown')).toBe(true);

    const personal = provide(withUnknownCosts(), 'mason', 'Parking', 500, 'personal').state;
    expect(personal.candidates[0].costs.find((c) => c.costId === 'gas')?.priceStatus).toBe('unknown');
  });

  it('a zero price is accepted as genuinely free, not treated as missing', () => {
    const result = provide(withUnknownCosts(), 'alex', 'Parking', 0, 'personal');
    const parking = result.state.candidates[0].costs.filter((c) => c.costId.startsWith('parking-'));
    expect(parking.every((c) => c.priceStatus === 'estimate' && c.highCents === 0)).toBe(true);
    expect(result.replies[0].text).toContain('Parking is free');
  });
});

describe('provide_cost: validation and scope', () => {
  it('rejects when nothing unknown matches the label and scope, and changes nothing', () => {
    const state = withUnknownCosts();
    const result = provide(state, 'mason', 'Lodging', 10_000, 'shared');
    expect(result.rejection?.code).toBe('AMBIGUOUS_ACTION');
    expect(result.state).toBe(state);
  });

  it('rejects the wrong scope for an existing label', () => {
    const result = provide(withUnknownCosts(), 'mason', 'Gas', 4_000, 'personal');
    expect(result.rejection?.code).toBe('AMBIGUOUS_ACTION');
  });

  it('rejects a negative or non-integer price without changing state', () => {
    const state = withUnknownCosts();
    for (const bad of [-100, 49.5]) {
      const result = provide(state, 'mason', 'Gas', bad, 'shared');
      expect(result.rejection?.code).toBe('INVALID_CONSTRAINT');
      expect(result.state).toBe(state);
    }
  });

  it('rejects a blank label', () => {
    const result = provide(withUnknownCosts(), 'mason', '   ', 1_000, 'shared');
    expect(result.rejection?.code).toBe('INVALID_CONSTRAINT');
  });

  it('leaves a candidate from an older revision untouched', () => {
    const state = withUnknownCosts();
    const stale = { ...state, candidates: [{ ...state.candidates[0], revision: 0 }, state.candidates[1]] };
    const result = provide(stale, 'mason', 'Gas', 4_000, 'shared');
    expect(result.state.candidates[0].costs.find((c) => c.costId === 'gas')?.priceStatus).toBe('unknown');
    expect(result.state.candidates[1].costs.find((c) => c.costId === 'gas')?.priceStatus).toBe('estimate');
  });

  it('strangers and non-consenting members cannot supply a price', () => {
    const state = withUnknownCosts();
    expect(provide(state, 'casey', 'Gas', 4_000, 'shared').rejection?.code).toBe('UNKNOWN_MEMBER');
  });

  it('never bumps the revision or touches acceptances: this is not a hard-constraint change', () => {
    const state = withUnknownCosts();
    const result = provide(state, 'mason', 'Gas', 4_000, 'shared');
    expect(result.state.revision).toBe(state.revision);
    expect(result.state.acceptances).toEqual(state.acceptances);
  });

  it('is pure: never mutates its input', () => {
    const state = withUnknownCosts();
    const snapshot = structuredClone(state);
    provide(state, 'mason', 'Gas', 4_000, 'shared');
    expect(state).toEqual(snapshot);
  });
});
