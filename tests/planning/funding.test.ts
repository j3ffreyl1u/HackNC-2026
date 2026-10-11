import { describe, expect, it } from 'vitest';
import { applyCommand, installCandidates } from '../../src/planning/commands.js';
import {
  categoryForMerchant,
  describeCoverage,
  describeWrapUp,
  driftNotices,
  ledgerStatus,
  planContributions,
  settleUpFor,
  spendVsPlan,
  trackCoverage,
  type Purchase,
} from '../../src/planning/funding.js';
import type { TripState } from '../../src/planning/types.js';
import { NOW, candidate, command, ids, readyState } from './fixtures.js';

/** An approved trip: option b (45,000 shared, 3,000 contingency, 2,000 personal food each), revision 1. */
function approved(sharedHigh = 45_000): TripState {
  let s = installCandidates(readyState(), 1, [candidate('b', sharedHigh)]).state;
  s = applyCommand(s, command('mason', { kind: 'select_candidate', candidateId: 'b', revision: s.revision }), { now: NOW }).state;
  for (const id of ids) s = applyCommand(s, command(id, { kind: 'accept_candidate', candidateId: 'b', revision: s.revision }), { now: NOW }).state;
  return s;
}

describe('planContributions', () => {
  it('works out each person\'s expected share of shared costs plus contingency, in whole dollars', () => {
    const plan = planContributions(approved());
    if (!plan.ok) throw new Error(plan.reason);
    // 45,000 shared + 3,000 contingency = 48,000 cents = $480.00, so $160 each.
    expect(plan.requests).toEqual(ids.map((memberId) => ({ memberId, dollars: 160 })));
    expect(plan.neededDollars).toBe(480);
    expect(plan.revision).toBe(1);
    expect(plan.candidateId).toBe('b');
  });

  it('rounds each expected share up, and the total never falls under the need', () => {
    // 45,100 + 3,000 = 48,100 cents over three people: 16,034 / 16,033 / 16,033 -> $161 each.
    const plan = planContributions(approved(45_100));
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.requests.map((r) => r.dollars)).toEqual([161, 161, 161]);
    expect(plan.neededDollars * 100).toBeGreaterThanOrEqual(48_100);
  });

  it('leaves personal costs out of the shared costs and lists them as the person\'s own', () => {
    const plan = planContributions(approved());
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.personalOwnDollars).toEqual(ids.map((memberId) => ({ memberId, dollars: 20 })));
  });

  it('refuses before the trip is approved, and says why', () => {
    const proposed = installCandidates(readyState(), 1, [candidate('b', 45_000)]).state;
    const plan = planContributions(proposed);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/approved/i);
  });

  it('refuses when a shared essential price is unknown, because unknown is never zero', () => {
    let s = readyState();
    const unknown = candidate('u', 45_000, ['hiking'], {});
    unknown.costs = unknown.costs.map((c) => (c.costId === 'cabin' ? { ...c, priceStatus: 'unknown' as const } : c));
    s = installCandidates(s, 1, [unknown]).state;
    s = { ...s, status: 'approved', selectedCandidateId: 'u', acceptances: ids.map((memberId) => ({ memberId, candidateId: 'u', revision: s.revision })) };
    const plan = planContributions(s);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/price/i);
  });
});

describe('categoryForMerchant', () => {
  it('maps known merchant categories and leaves the rest unclassified', () => {
    expect(categoryForMerchant('gas')).toBe('fuel_parking_tolls');
    expect(categoryForMerchant('Restaurant')).toBe('food');
    expect(categoryForMerchant('lodging')).toBe('accommodation');
    expect(categoryForMerchant('parks')).toBe('activities');
    expect(categoryForMerchant('weird thing')).toBeUndefined();
    expect(categoryForMerchant(undefined)).toBeUndefined();
  });
});

describe('spendVsPlan', () => {
  const plan = () => {
    const p = planContributions(approved());
    if (!p.ok) throw new Error(p.reason);
    return p;
  };

  it('compares spending to the pooled plan by category and keeps the unknown apart', () => {
    const report = spendVsPlan(plan(), [
      { id: 'p1', amountDollars: 300, category: 'accommodation' },
      { id: 'p2', amountDollars: 40, category: 'mystery shop' },
    ]);
    const lodging = report.byCategory.find((c) => c.category === 'accommodation')!;
    expect(lodging.plannedDollars).toBe(450);
    expect(lodging.spentDollars).toBe(300);
    expect(lodging.state).toBe('within');
    expect(report.unclassifiedDollars).toBe(40);
    expect(report.totalSpentDollars).toBe(340);
    expect(report.contingencyDollars).toBe(30);
  });

  it('flags a category that is nearly used up, and one that is over', () => {
    const near = spendVsPlan(plan(), [{ id: 'p1', amountDollars: 400, category: 'accommodation' }]);
    expect(near.byCategory.find((c) => c.category === 'accommodation')?.state).toBe('near');
    const over = spendVsPlan(plan(), [{ id: 'p1', amountDollars: 460, category: 'accommodation' }]);
    expect(over.byCategory.find((c) => c.category === 'accommodation')?.state).toBe('over');
    expect(over.overCategories).toEqual(['accommodation']);
  });

  it('treats spending in a category the plan never budgeted as over', () => {
    const report = spendVsPlan(plan(), [{ id: 'p1', amountDollars: 25, category: 'gas' }]);
    const fuel = report.byCategory.find((c) => c.category === 'fuel_parking_tolls')!;
    expect(fuel.plannedDollars).toBe(0);
    expect(fuel.state).toBe('over');
  });

  it('counts a repeated purchase id once and skips purchases that are not completed', () => {
    const report = spendVsPlan(plan(), [
      { id: 'p1', amountDollars: 10, category: 'food' },
      { id: 'p1', amountDollars: 10, category: 'food' },
      { id: 'p2', amountDollars: 99, category: 'food', status: 'pending' },
    ]);
    expect(report.totalSpentDollars).toBe(10);
  });
});

describe('driftNotices', () => {
  const plan = () => {
    const p = planContributions(approved());
    if (!p.ok) throw new Error(p.reason);
    return p;
  };

  it('says nothing while spending is within the plan', () => {
    const report = spendVsPlan(plan(), [{ id: 'p', amountDollars: 100, category: 'accommodation' }]);
    expect(driftNotices(report, new Set())).toEqual([]);
  });

  it('gives a calm heads-up when a category is nearly used, with no one named', () => {
    const report = spendVsPlan(plan(), [{ id: 'p', amountDollars: 400, category: 'accommodation' }]);
    const [notice] = driftNotices(report, new Set());
    expect(notice.key).toBe('accommodation:near');
    expect(notice.text).toMatch(/lodging/i);
    expect(notice.text).toMatch(/\$400 of the \$450/);
    expect(notice.text).not.toMatch(/Mason|Alex|Jordan/);
  });

  it('offers to look for cheaper options when a category goes over, but changes nothing itself', () => {
    const report = spendVsPlan(plan(), [{ id: 'p', amountDollars: 470, category: 'accommodation' }]);
    const [notice] = driftNotices(report, new Set());
    expect(notice.key).toBe('accommodation:over');
    expect(notice.text).toMatch(/over/i);
    expect(notice.text).toMatch(/cheaper options/i);
    expect(notice.text).toMatch(/everyone would need to agree/i);
  });

  it('does not repeat a notice it has already given, but does say it again when things get worse', () => {
    const near = spendVsPlan(plan(), [{ id: 'p', amountDollars: 400, category: 'accommodation' }]);
    const announced = new Set(driftNotices(near, new Set()).map((n) => n.key));
    expect(driftNotices(near, announced)).toEqual([]);
    const over = spendVsPlan(plan(), [{ id: 'p', amountDollars: 470, category: 'accommodation' }]);
    expect(driftNotices(over, announced).map((n) => n.key)).toEqual(['accommodation:over']);
  });

  it('explains spending in a category the plan never budgeted for, and mentions unclassified spending once', () => {
    const report = spendVsPlan(plan(), [
      { id: 'a', amountDollars: 25, category: 'gas' },
      { id: 'b', amountDollars: 40, category: 'mystery shop' },
    ]);
    const notices = driftNotices(report, new Set());
    expect(notices.map((n) => n.key)).toEqual(['fuel_parking_tolls:over', 'unclassified']);
    expect(notices[0].text).toMatch(/didn't budget/i);
    expect(notices[1].text).toMatch(/\$40/);
    expect(driftNotices(report, new Set(notices.map((n) => n.key)))).toEqual([]);
  });
});


// ---- who covered what ----------------------------------------------------------------------------------------

const planOf = (sharedHigh = 45_000) => {
  const plan = planContributions(approved(sharedHigh));
  if (!plan.ok) throw new Error(plan.reason);
  return plan;
};
const buy = (memberId: string, dollars: number, category: string, extra: Partial<Purchase> = {}): Purchase => ({ id: `${memberId}-${category}-${dollars}-${Math.random()}`, memberId, amountDollars: dollars, category, status: 'completed', ...extra });
const [A, B, C] = ids;

describe('trackCoverage', () => {
  it('splits shared costs equally and says who is owed: one person pays the whole bill', () => {
    const ledger = trackCoverage(planOf(), [buy(A!, 60, 'gas')]);
    expect(ledger.sharedSpentDollars).toBe(60);
    expect(ledger.perMember.map((m) => [m.memberId, m.coveredDollars, m.fairShareDollars, m.netDollars])).toEqual([[A, 60, 20, 40], [B, 0, 20, -20], [C, 0, 20, -20]]);
    expect(ledger.transfers).toEqual([{ fromMemberId: B, toMemberId: A, dollars: 20 }, { fromMemberId: C, toMemberId: A, dollars: 20 }]);
  });
  it('lets different people cover different things, and only the difference moves', () => {
    const ledger = trackCoverage(planOf(), [buy(A!, 300, 'hotel'), buy(B!, 60, 'gas'), buy(C!, 30, 'parks')]);
    expect(ledger.sharedSpentDollars).toBe(390);
    expect(ledger.perMember.map((m) => m.netDollars)).toEqual([170, -70, -100]);
    expect(ledger.transfers).toEqual([{ fromMemberId: C, toMemberId: A, dollars: 100 }, { fromMemberId: B, toMemberId: A, dollars: 70 }]);
  });
  it('keeps what each person covered by category', () => {
    const ledger = trackCoverage(planOf(), [buy(A!, 200, 'hotel'), buy(A!, 40, 'gas'), buy(A!, 20, 'fuel')]);
    expect(ledger.perMember[0]!.byCategory).toEqual([{ category: 'accommodation', dollars: 200 }, { category: 'fuel_parking_tolls', dollars: 60 }]);
  });
  it('is even when everyone covered the same', () => {
    const ledger = trackCoverage(planOf(), [buy(A!, 50, 'gas'), buy(B!, 50, 'gas'), buy(C!, 50, 'gas')]);
    expect(ledger.transfers).toEqual([]); expect(ledgerStatus(ledger)).toBe('settled');
  });
  it('is only tracking while nothing shared has been covered', () => {
    const ledger = trackCoverage(planOf(), []);
    expect(ledger.sharedSpentDollars).toBe(0); expect(ledger.transfers).toEqual([]); expect(ledgerStatus(ledger)).toBe('tracking');
  });
  it('keeps food personal unless the group said otherwise', () => {
    const lunch = buy(A!, 45, 'restaurant', { id: 'lunch' });
    expect(trackCoverage(planOf(), [lunch]).sharedSpentDollars).toBe(0);
    expect(trackCoverage(planOf(), [lunch]).personalDollars).toBe(45);
    const shared = trackCoverage(planOf(), [lunch], { sharedPurchaseIds: new Set(['lunch']) });
    expect(shared.sharedSpentDollars).toBe(45); expect(shared.transfers).toHaveLength(2);
  });
  it('leaves a purchase with no category out of the split, and says how much', () => {
    const ledger = trackCoverage(planOf(), [buy(A!, 80, 'casino'), buy(A!, 30, 'gas')]);
    expect(ledger.unclassifiedDollars).toBe(80); expect(ledger.sharedSpentDollars).toBe(30);
  });
  it('never credits an account that is not on the trip', () => {
    const ledger = trackCoverage(planOf(), [buy('stranger', 500, 'hotel'), { id: 'x', amountDollars: 9, category: 'gas', status: 'completed' }]);
    expect(ledger.unattributedDollars).toBe(509); expect(ledger.sharedSpentDollars).toBe(0);
  });
  it('counts a repeated purchase id once and skips purchases that did not complete', () => {
    const once = buy(A!, 40, 'gas', { id: 'same' });
    const ledger = trackCoverage(planOf(), [once, { ...once }, buy(B!, 99, 'gas', { status: 'pending' }), buy(B!, 10, 'gas', { amountDollars: Number.NaN })]);
    expect(ledger.sharedSpentDollars).toBe(40);
  });
  it('counts only purchases inside the trip period', () => {
    const ledger = trackCoverage(planOf(), [buy(A!, 100, 'hotel', { date: '2026-10-12' }), buy(A!, 70, 'gas', { date: '2026-09-01' }), buy(A!, 20, 'gas', { date: '2026-12-31' }), buy(A!, 5, 'gas')], { from: '2026-10-10', to: '2026-11-20' });
    expect(ledger.sharedSpentDollars).toBe(105); expect(ledger.outsideTripDollars).toBe(90);
  });
  it('compares shared spending with the plan, and never counts food against the shared budget', () => {
    const ledger = trackCoverage(planOf(), [buy(A!, 900, 'hotel'), buy(B!, 500, 'restaurant')]);
    expect(ledger.spend.overCategories).toContain('accommodation');
    expect(ledger.spend.byCategory.some((c) => c.category === 'food')).toBe(false);
  });
});

describe('the numbers always add up (seeded)', () => {
  it('fair shares sum to the shared total, nets sum to zero, and the transfers settle every net exactly', () => {
    let seed = 20261011;
    const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const cats = ['hotel', 'gas', 'parks', 'parking', 'tolls'];
    for (let round = 0; round < 300; round++) {
      const purchases = Array.from({ length: Math.floor(rand() * 9) }, () => buy(ids[Math.floor(rand() * ids.length)]!, 1 + Math.floor(rand() * 400), cats[Math.floor(rand() * cats.length)]!));
      const ledger = trackCoverage(planOf(), purchases);
      expect(ledger.perMember.reduce((a, m) => a + m.fairShareDollars, 0)).toBe(ledger.sharedSpentDollars);
      expect(ledger.perMember.reduce((a, m) => a + m.netDollars, 0)).toBe(0);
      const moved = new Map<string, number>(ids.map((id) => [id, 0]));
      for (const t of ledger.transfers) { moved.set(t.fromMemberId, moved.get(t.fromMemberId)! + t.dollars); moved.set(t.toMemberId, moved.get(t.toMemberId)! - t.dollars); expect(t.dollars).toBeGreaterThan(0); expect(t.fromMemberId).not.toBe(t.toMemberId); }
      for (const m of ledger.perMember) expect(-moved.get(m.memberId)! + 0, `${m.memberId} in round ${round}`).toBe(m.netDollars + 0);   // + 0 turns -0 into 0
      expect(ledger.transfers.length).toBeLessThanOrEqual(ids.length - 1);
    }
  });
});

describe('what the bot says about who covered what', () => {
  const state = approved();
  const plan = planOf();
  it('says what each person covered, the fair share, and who owes whom, in three short lines, labelled simulated', () => {
    const text = describeCoverage(state, plan, trackCoverage(plan, [buy(A!, 300, 'hotel'), buy(B!, 60, 'gas')]), { simulated: true });
    expect(text).toMatch(/Covered so far:.*\$300.*\$60/); expect(text).toMatch(/Fair share is about \$120 each/); expect(text).toMatch(/owes/); expect(text).toMatch(/Simulated money/);
    expect(text.split('\n').length).toBeLessThanOrEqual(3);
    expect(text).not.toMatch(/\bmax\b|limit|cap\b/i);
  });
  it('says so when nothing has been covered, and when everyone is even', () => {
    expect(describeCoverage(state, plan, trackCoverage(plan, []))).toMatch(/Nothing shared has been covered yet/);
    expect(describeCoverage(state, plan, trackCoverage(plan, [buy(A!, 30, 'gas'), buy(B!, 30, 'gas'), buy(C!, 30, 'gas')]))).toMatch(/even/);
  });
  it('settleUpFor tells one person what they owe, and nothing about anyone else', () => {
    const ledger = trackCoverage(plan, [buy(A!, 60, 'gas')]);
    expect(settleUpFor(state, B!, ledger)).toMatch(/you owe .*\$20/i);
    expect(settleUpFor(state, A!, ledger)).toBeUndefined();
  });
  it('the wrap-up says who sends whom, that the bot moves no money, and what it left out', () => {
    const ledger = trackCoverage(plan, [buy(A!, 90, 'hotel'), buy(B!, 40, 'casino'), buy('stranger', 5, 'gas')]);
    const text = describeWrapUp(state, ledger, { simulated: true });
    expect(text).toMatch(/\$90 of shared costs, about \$30 each/); expect(text).toMatch(/sends/); expect(text).toMatch(/had no category/); expect(text).toMatch(/isn't on this trip/);
    expect(text).toMatch(/don't move any money/); expect(text).toMatch(/Simulated money/);
  });
  it('a wrap-up with nothing covered says nobody owes anyone', () => {
    expect(describeWrapUp(state, trackCoverage(plan, []))).toMatch(/nobody owes anyone/);
  });
});
