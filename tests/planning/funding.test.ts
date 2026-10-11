import { describe, expect, it } from 'vitest';
import { applyCommand, installCandidates } from '../../src/planning/commands.js';
import {
  categoryForMerchant,
  checkFunding,
  depositTag,
  describeFund,
  describeSettlement,
  driftNotices,
  parseDepositTag,
  planContributions,
  reminderFor,
  settleTrip,
  spendVsPlan,
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
  it('asks each person for their share of shared costs plus contingency, in whole dollars', () => {
    const plan = planContributions(approved());
    if (!plan.ok) throw new Error(plan.reason);
    // 45,000 shared + 3,000 contingency = 48,000 cents = $480.00, so $160 each.
    expect(plan.requests).toEqual(ids.map((memberId) => ({ memberId, dollars: 160 })));
    expect(plan.neededDollars).toBe(480);
    expect(plan.revision).toBe(1);
    expect(plan.candidateId).toBe('b');
  });

  it('rounds each share up so the account is never short, and the total never falls under the need', () => {
    // 45,100 + 3,000 = 48,100 cents over three people: 16,034 / 16,033 / 16,033 -> $161 each.
    const plan = planContributions(approved(45_100));
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.requests.map((r) => r.dollars)).toEqual([161, 161, 161]);
    expect(plan.neededDollars * 100).toBeGreaterThanOrEqual(48_100);
  });

  it('leaves personal costs out of the pool and lists them as the person\'s own', () => {
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

describe('deposit tags', () => {
  it('round-trips member and revision, and ignores anything else', () => {
    expect(parseDepositTag(depositTag('mason', 3))).toEqual({ memberId: 'mason', revision: 3 });
    expect(parseDepositTag('hello')).toBeUndefined();
    expect(parseDepositTag('member=;rev=3')).toBeUndefined();
    expect(parseDepositTag('member=alex;rev=x')).toBeUndefined();
    expect(parseDepositTag('member=alex;rev=3;completed')).toEqual({ memberId: 'alex', revision: 3 });
  });
});

describe('checkFunding', () => {
  const plan = () => {
    const p = planContributions(approved());
    if (!p.ok) throw new Error(p.reason);
    return p;
  };

  it('is requesting when nothing has arrived', () => {
    const report = checkFunding(plan(), []);
    expect(report.status).toBe('requesting');
    expect(report.collectedDollars).toBe(0);
    expect(report.neededDollars).toBe(480);
    expect(report.perMember.map((m) => m.outstandingDollars)).toEqual([160, 160, 160]);
  });

  it('is partly funded and names who is still outstanding', () => {
    const report = checkFunding(plan(), [
      { id: 'd1', amountDollars: 160, description: depositTag('mason', 1) },
      { id: 'd2', amountDollars: 100, description: depositTag('alex', 1) },
    ]);
    expect(report.status).toBe('partially_funded');
    expect(report.collectedDollars).toBe(260);
    expect(report.perMember.find((m) => m.memberId === 'alex')?.outstandingDollars).toBe(60);
    expect(report.perMember.find((m) => m.memberId === 'jordan')?.outstandingDollars).toBe(160);
    expect(report.missingMemberIds).toEqual(['alex', 'jordan']);
  });

  it('is funded only when every person has covered their own share', () => {
    const everyone = ids.map((id, i) => ({ id: `d${i}`, amountDollars: 160, description: depositTag(id, 1) }));
    expect(checkFunding(plan(), everyone).status).toBe('funded');
    // One person paying everybody's share does not fund the others' obligations.
    const oneBigDeposit = [{ id: 'x', amountDollars: 480, description: depositTag('mason', 1) }];
    const report = checkFunding(plan(), oneBigDeposit);
    expect(report.status).toBe('partially_funded');
    expect(report.perMember.find((m) => m.memberId === 'alex')?.outstandingDollars).toBe(160);
  });

  it('does not count deposits for an old revision, and reports them separately', () => {
    const report = checkFunding(plan(), [{ id: 'old', amountDollars: 160, description: depositTag('mason', 0) }]);
    expect(report.status).toBe('requesting');
    expect(report.collectedDollars).toBe(0);
    expect(report.staleDollars).toBe(160);
  });

  it('keeps untagged deposits apart and never counts them toward a person', () => {
    const report = checkFunding(plan(), [{ id: 'mystery', amountDollars: 160, description: 'cash' }]);
    expect(report.collectedDollars).toBe(0);
    expect(report.unattributedDollars).toBe(160);
  });

  it('counts a repeated deposit id once and ignores deposits that are not completed', () => {
    const report = checkFunding(plan(), [
      { id: 'd1', amountDollars: 160, description: depositTag('mason', 1) },
      { id: 'd1', amountDollars: 160, description: depositTag('mason', 1) },
      { id: 'p1', amountDollars: 160, description: depositTag('alex', 1), status: 'pending' },
    ]);
    expect(report.collectedDollars).toBe(160);
    expect(report.perMember.find((m) => m.memberId === 'alex')?.paidDollars).toBe(0);
  });

  it('never names an amount for a person who is not on the trip', () => {
    const report = checkFunding(plan(), [{ id: 'z', amountDollars: 50, description: depositTag('stranger', 1) }]);
    expect(report.collectedDollars).toBe(0);
    expect(report.unattributedDollars).toBe(50);
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

describe('describeFund', () => {
  const setup = () => {
    const state = approved();
    const plan = planContributions(state);
    if (!plan.ok) throw new Error(plan.reason);
    return { state, plan };
  };

  it('says how much is in, who the fund is still waiting on, and that it is simulated money when asked to', () => {
    const { state, plan } = setup();
    const funding = checkFunding(plan, [
      { id: 'a', amountDollars: 160, description: depositTag('mason', 1) },
      { id: 'b', amountDollars: 100, description: depositTag('alex', 1) },
    ]);
    const text = describeFund(state, plan, funding, undefined, { simulated: true });
    expect(text).toMatch(/\$260 of \$480/);
    expect(text).toMatch(/Alex \(\$60\)/);
    expect(text).toMatch(/Jordan \(\$160\)/);
    expect(text).not.toMatch(/Mason \(/);
    expect(text).toMatch(/simulated/i);
  });

  it('says the fund is fully funded when it is, and adds spending when it is given', () => {
    const { state, plan } = setup();
    const funding = checkFunding(plan, ids.map((id, i) => ({ id: `d${i}`, amountDollars: 160, description: depositTag(id, 1) })));
    const spend = spendVsPlan(plan, [{ id: 'p', amountDollars: 120, category: 'accommodation' }]);
    const text = describeFund(state, plan, funding, spend);
    expect(text).toMatch(/fully funded/i);
    expect(text).toMatch(/\$120 spent/);
    expect(text).toMatch(/\$360 left/);
  });
});

describe('reminderFor', () => {
  it('tells one person what they still owe, and nothing about anyone else', () => {
    const plan = planContributions(approved());
    if (!plan.ok) throw new Error(plan.reason);
    const funding = checkFunding(plan, [{ id: 'a', amountDollars: 100, description: depositTag('alex', 1) }]);
    expect(reminderFor('alex', funding)).toMatch(/\$60/);
    expect(reminderFor('alex', funding)).not.toMatch(/Jordan|Mason/);
    expect(reminderFor('mason', funding)).toMatch(/\$160/);
    const paid = checkFunding(plan, ids.map((id, i) => ({ id: `d${i}`, amountDollars: 160, description: depositTag(id, 1) })));
    expect(reminderFor('alex', paid)).toBeUndefined();
    expect(reminderFor('stranger', funding)).toBeUndefined();
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

describe('settleTrip', () => {
  const plan = () => {
    const p = planContributions(approved());
    if (!p.ok) throw new Error(p.reason);
    return p;
  };
  const paidIn = (dollars: Record<string, number>, revision = 1) =>
    Object.entries(dollars).map(([id, amountDollars], i) => ({ id: `d${i}-${revision}`, amountDollars, description: depositTag(id, revision) }));

  it('returns what is left to the people who put it in, in proportion', () => {
    const p = plan();
    const funding = checkFunding(p, paidIn({ mason: 160, alex: 160, jordan: 160 }));
    const spend = spendVsPlan(p, [{ id: 'a', amountDollars: 330, category: 'accommodation' }]);
    const s = settleTrip(p, funding, spend);
    expect(s.collectedDollars).toBe(480);
    expect(s.spentDollars).toBe(330);
    expect(s.leftoverDollars).toBe(150);
    expect(s.refunds).toEqual([{ memberId: 'mason', dollars: 50 }, { memberId: 'alex', dollars: 50 }, { memberId: 'jordan', dollars: 50 }]);
    expect(s.shortfall).toBeUndefined();
  });

  it('refunds always add up exactly to the leftover, and larger contributions get at least as much back', () => {
    const p = plan();
    const funding = checkFunding(p, paidIn({ mason: 160, alex: 160, jordan: 170 }));
    const spend = spendVsPlan(p, [{ id: 'a', amountDollars: 331, category: 'accommodation' }]);
    const s = settleTrip(p, funding, spend);
    expect(s.leftoverDollars).toBe(159);
    expect(s.refunds.reduce((t, r) => t + r.dollars, 0)).toBe(159);
    const get = (id: string) => s.refunds.find((r) => r.memberId === id)!.dollars;
    expect(get('jordan')).toBeGreaterThanOrEqual(get('mason'));
  });

  it('gives the extra dollars to the largest remainders, not just the first people on the list', () => {
    const p = plan();
    const funding = checkFunding(p, paidIn({ mason: 170, alex: 160, jordan: 160 }));
    const s = settleTrip(p, funding, spendVsPlan(p, [{ id: 'a', amountDollars: 331, category: 'accommodation' }]));
    // 159 left over 490 in: shares 55.2, 51.9, 51.9. The two spare dollars go to alex and jordan, not mason.
    expect(s.refunds).toEqual([{ memberId: 'mason', dollars: 55 }, { memberId: 'alex', dollars: 52 }, { memberId: 'jordan', dollars: 52 }]);
  });

  it('reports a shortfall and a whole-dollar equal split of it when the fund was overspent', () => {
    const p = plan();
    const funding = checkFunding(p, paidIn({ mason: 160, alex: 160, jordan: 160 }));
    const spend = spendVsPlan(p, [{ id: 'a', amountDollars: 500, category: 'accommodation' }]);
    const s = settleTrip(p, funding, spend);
    expect(s.leftoverDollars).toBe(-20);
    expect(s.refunds).toEqual([]);
    expect(s.shortfall?.dollars).toBe(20);
    expect(s.shortfall?.perMember).toEqual(ids.map((memberId) => ({ memberId, dollars: 7 })));
  });

  it('returns deposits made for an older plan revision to the person who sent them', () => {
    const p = plan();
    const funding = checkFunding(p, [...paidIn({ mason: 160, alex: 160, jordan: 160 }), ...paidIn({ alex: 90 }, 0)]);
    const s = settleTrip(p, funding, spendVsPlan(p, []));
    expect(s.staleReturns).toEqual([{ memberId: 'alex', dollars: 90 }]);
    expect(s.leftoverDollars).toBe(480);
  });

  it('keeps unattributed money apart for someone to claim', () => {
    const p = plan();
    const funding = checkFunding(p, [{ id: 'm', amountDollars: 75, description: 'cash' }]);
    const s = settleTrip(p, funding, spendVsPlan(p, []));
    expect(s.unattributedDollars).toBe(75);
    expect(s.refunds).toEqual([]);
  });

  it('has nothing to return when nobody paid in', () => {
    const p = plan();
    const s = settleTrip(p, checkFunding(p, []), spendVsPlan(p, []));
    expect(s.refunds).toEqual([]);
    expect(s.leftoverDollars).toBe(0);
  });
});

describe('describeSettlement', () => {
  it('says what came in, what went out and who gets what back, and that the bot moves nothing', () => {
    const state = approved();
    const p = planContributions(state);
    if (!p.ok) throw new Error(p.reason);
    const funding = checkFunding(p, ids.map((id, i) => ({ id: `d${i}`, amountDollars: 160, description: depositTag(id, 1) })));
    const text = describeSettlement(state, settleTrip(p, funding, spendVsPlan(p, [{ id: 'a', amountDollars: 330, category: 'accommodation' }])), { simulated: true });
    expect(text).toMatch(/\$480 in/);
    expect(text).toMatch(/\$330 spent/);
    expect(text).toMatch(/\$150 left/);
    expect(text).toMatch(/Mason \$50/);
    expect(text).toMatch(/send|return/i);
    expect(text).toMatch(/I don't move any money/i);
    expect(text).toMatch(/simulated/i);
  });

  it('explains a shortfall without blaming anyone', () => {
    const state = approved();
    const p = planContributions(state);
    if (!p.ok) throw new Error(p.reason);
    const funding = checkFunding(p, ids.map((id, i) => ({ id: `d${i}`, amountDollars: 160, description: depositTag(id, 1) })));
    const text = describeSettlement(state, settleTrip(p, funding, spendVsPlan(p, [{ id: 'a', amountDollars: 500, category: 'accommodation' }])));
    expect(text).toMatch(/\$20 short/);
    expect(text).toMatch(/\$7 each/);
  });
});
