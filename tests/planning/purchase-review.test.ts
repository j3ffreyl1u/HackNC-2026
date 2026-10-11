import { describe, expect, it } from 'vitest';
import { applyCommand, installCandidates } from '../../src/planning/commands.js';
import { planContributions, reviewPurchases, trackCoverage, type Purchase } from '../../src/planning/funding.js';
import { NOW, candidate, command, ids, readyState } from './fixtures.js';

// Option b: $450 budgeted for lodging (the only shared line), food personal.
function plan() {
  let s = installCandidates(readyState(), 1, [candidate('b', 45_000)]).state;
  s = applyCommand(s, command('mason', { kind: 'select_candidate', candidateId: 'b', revision: s.revision }), { now: NOW }).state;
  for (const id of ids) s = applyCommand(s, command(id, { kind: 'accept_candidate', candidateId: 'b', revision: s.revision }), { now: NOW }).state;
  const p = planContributions(s);
  if (!p.ok) throw new Error(p.reason);
  return p;
}
const buy = (id: string, memberId: string, amountDollars: number, category: string, date = '2026-10-15'): Purchase => ({ id, memberId, amountDollars, category, date, status: 'completed' });

describe('reviewPurchases', () => {
  it('counts purchases that fit the plan without asking anyone', () => {
    const r = reviewPurchases(plan(), [buy('a', 'mason', 300, 'hotel'), buy('b', 'alex', 120, 'cabin')], {});
    expect(r.flagged).toEqual([]); expect(r.counted.map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('never asks about food, which stays personal', () => {
    const r = reviewPurchases(plan(), [buy('f', 'alex', 90, 'restaurant')], {});
    expect(r.flagged).toEqual([]); expect(r.counted).toHaveLength(1);
  });
  it('flags a purchase with no recognised category and holds it back', () => {
    const r = reviewPurchases(plan(), [buy('x', 'jordan', 80, 'casino')], {});
    expect(r.flagged.map((f) => [f.purchase.id, f.reason])).toEqual([['x', 'unrecognised']]); expect(r.counted).toEqual([]);
  });
  it('lets the plan\'s $30 contingency absorb a small overrun, then asks once it is used up', () => {
    const r = reviewPurchases(plan(), [buy('g1', 'alex', 25, 'gas', '2026-10-14'), buy('g2', 'alex', 20, 'gas', '2026-10-15')], {});
    expect(r.counted.map((p) => p.id)).toEqual(['g1']); expect(r.flagged.map((f) => [f.purchase.id, f.reason])).toEqual([['g2', 'not_in_plan']]);
  });
  it('flags a shared category the plan never budgeted', () => {
    const r = reviewPurchases(plan(), [buy('g', 'alex', 60, 'gas')], {});
    expect(r.flagged.map((f) => f.reason)).toEqual(['not_in_plan']);
  });
  it('flags only the purchase that pushes a category over its budget', () => {
    const r = reviewPurchases(plan(), [buy('a', 'mason', 400, 'hotel', '2026-10-14'), buy('b', 'alex', 100, 'hotel', '2026-10-15')], {});
    expect(r.counted.map((p) => p.id)).toEqual(['a']); expect(r.flagged.map((f) => [f.purchase.id, f.reason])).toEqual([['b', 'over_plan']]);
  });
  it('a "trip" answer counts the purchase, an unrecognised one as other; a "personal" answer drops it', () => {
    const r = reviewPurchases(plan(), [buy('x', 'jordan', 80, 'casino'), buy('y', 'alex', 60, 'gas')], { x: 'trip', y: 'personal' });
    expect(r.flagged).toEqual([]); expect(r.counted.map((p) => [p.id, p.category])).toEqual([['x', 'other']]);
  });
  it('an answered purchase can be counted by the ledger', () => {
    const p = plan(); const r = reviewPurchases(p, [buy('x', 'jordan', 80, 'casino')], { x: 'trip' });
    const ledger = trackCoverage(p, r.counted); expect(ledger.sharedSpentDollars).toBe(80); expect(ledger.unclassifiedDollars).toBe(0);
  });
  it('ignores pending, duplicate, off-trip and outside-account purchases rather than asking about them', () => {
    const odd: Purchase[] = [{ ...buy('p', 'jordan', 80, 'casino'), status: 'pending' }, buy('d', 'jordan', 80, 'casino'), buy('d', 'jordan', 80, 'casino'), buy('o', 'jordan', 80, 'casino', '2026-09-01'), buy('s', 'stranger', 80, 'casino')];
    const r = reviewPurchases(plan(), odd, {}, { from: '2026-10-10', to: '2026-10-20' });
    expect(r.flagged.map((f) => f.purchase.id)).toEqual(['d']);
  });
  it('does not depend on the order purchases arrive in', () => {
    const list = [buy('b', 'alex', 100, 'hotel', '2026-10-15'), buy('a', 'mason', 400, 'hotel', '2026-10-14')];
    expect(reviewPurchases(plan(), list, {}).flagged.map((f) => f.purchase.id)).toEqual(['b']);
  });
});
