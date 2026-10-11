import { describe, expect, it } from 'vitest';
import { allocateCosts } from '../../src/planning/budget.js';
import { applyCommand, installCandidates } from '../../src/planning/commands.js';
import { checkFunding, depositTag, planContributions, settleTrip, spendVsPlan, type Deposit, type Purchase } from '../../src/planning/funding.js';
import { splitEqual } from '../../src/planning/money.js';
import type { CostItem, TripState } from '../../src/planning/types.js';
import { NOW, candidate, command, ids, readyState } from './fixtures.js';

// Randomised checks with a fixed seed, so a failure can be reproduced exactly. The properties are the promises
// the money code makes: shares add up to the total to the cent, rounding up never leaves the fund short, results
// do not depend on the order deposits arrive in, and refunds add up exactly.

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const CASES = 300;

describe('splitEqual', () => {
  it('always adds up to the total, differs by at most a cent, and gives extras to the earliest', () => {
    const r = rng(1);
    for (let i = 0; i < CASES; i++) {
      const total = int(r, 0, 5_000_000);
      const n = int(r, 1, 12);
      const people = Array.from({ length: n }, (_, k) => `p${k}`);
      const shares = people.map((p) => splitEqual(total, people)[p]!);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
      for (let k = 1; k < n; k++) expect(shares[k - 1]!).toBeGreaterThanOrEqual(shares[k]!);
    }
  });
});

describe('allocateCosts', () => {
  it('splits every cent: totals equal shared plus personal plus contingency, and low never exceeds high', () => {
    const r = rng(2);
    for (let i = 0; i < CASES; i++) {
      const n = int(r, 1, 6);
      const people = Array.from({ length: n }, (_, k) => `p${k}`);
      const costs: CostItem[] = [];
      let sharedLow = 0, sharedHigh = 0, personalLow = 0, personalHigh = 0;
      for (let c = 0; c < int(r, 0, 5); c++) {
        const low = int(r, 0, 100_000);
        const high = low + int(r, 0, 50_000);
        const personal = r() < 0.4;
        costs.push({ costId: `c${c}`, category: 'other', label: 'x', lowCents: low, highCents: high, allocation: personal ? 'personal' : 'equal_shared', ...(personal ? { memberId: people[int(r, 0, n - 1)]! } : {}), evidenceIds: [], priceStatus: 'estimate' });
        if (personal) { personalLow += low; personalHigh += high; } else { sharedLow += low; sharedHigh += high; }
      }
      const contingency = int(r, 0, 20_000);
      const { perPersonTotals } = allocateCosts(people, costs, contingency);
      expect(perPersonTotals.reduce((t, p) => t + p.highCents, 0)).toBe(sharedHigh + personalHigh + contingency);
      expect(perPersonTotals.reduce((t, p) => t + p.lowCents, 0)).toBe(sharedLow + personalLow);
      for (const p of perPersonTotals) expect(p.lowCents).toBeLessThanOrEqual(p.highCents);
    }
  });
});

/** An approved trip whose only candidate is swapped for one with random shared costs and contingency. */
function approvedWith(sharedHigh: number, contingency: number): TripState {
  let s = installCandidates(readyState(), 1, [candidate('b', 45_000)]).state;
  s = applyCommand(s, command('mason', { kind: 'select_candidate', candidateId: 'b', revision: s.revision }), { now: NOW }).state;
  for (const id of ids) s = applyCommand(s, command(id, { kind: 'accept_candidate', candidateId: 'b', revision: s.revision }), { now: NOW }).state;
  const c = s.candidates[0]!;
  return { ...s, candidates: [{ ...c, contingencyCents: contingency, costs: c.costs.map((x) => (x.costId === 'cabin' ? { ...x, lowCents: 0, highCents: sharedHigh } : x)) }] };
}

describe('planContributions', () => {
  it('never leaves the fund short and never over-asks by a full dollar each', () => {
    const r = rng(3);
    for (let i = 0; i < CASES; i++) {
      const sharedHigh = int(r, 0, 2_000_000);
      const contingency = int(r, 0, 100_000);
      const plan = planContributions(approvedWith(sharedHigh, contingency));
      if (!plan.ok) throw new Error(plan.reason);
      const pooled = sharedHigh + contingency;
      expect(plan.neededDollars * 100).toBeGreaterThanOrEqual(pooled);
      expect(plan.neededDollars * 100 - pooled).toBeLessThan(ids.length * 100);
    }
  });
});

function randomDeposits(r: () => number, revision: number): Deposit[] {
  const members = [...ids, 'stranger'];
  return Array.from({ length: int(r, 0, 12) }, (_, k) => ({
    id: `d${k}`,
    amountDollars: int(r, 0, 300),
    description: r() < 0.15 ? 'cash' : depositTag(members[int(r, 0, members.length - 1)]!, r() < 0.2 ? revision - 1 : revision),
    ...(r() < 0.15 ? { status: 'pending' } : {}),
  }));
}
const shuffle = <T,>(r: () => number, list: T[]): T[] => list.map((x) => [r(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

describe('checkFunding', () => {
  const plan = (() => { const p = planContributions(approvedWith(45_000, 3_000)); if (!p.ok) throw new Error(p.reason); return p; })();

  it('does not depend on arrival order, counts a repeated deposit once, and never credits more than was sent', () => {
    const r = rng(4);
    for (let i = 0; i < CASES; i++) {
      const deposits = randomDeposits(r, plan.revision);
      const report = checkFunding(plan, deposits);
      expect(checkFunding(plan, shuffle(r, deposits))).toEqual(report);
      expect(checkFunding(plan, [...deposits, ...deposits])).toEqual(report);
      const sent = deposits.filter((d) => d.status === undefined).reduce((t, d) => t + d.amountDollars, 0);
      expect(report.collectedDollars + report.staleDollars + report.unattributedDollars).toBeLessThanOrEqual(sent);
      expect(report.collectedDollars).toBe(report.perMember.reduce((t, m) => t + m.paidDollars, 0));
      for (const m of report.perMember) expect(m.outstandingDollars).toBe(Math.max(0, m.requestedDollars - m.paidDollars));
      expect(report.status === 'funded').toBe(report.missingMemberIds.length === 0);
    }
  });
});

describe('settleTrip', () => {
  const plan = (() => { const p = planContributions(approvedWith(45_000, 3_000)); if (!p.ok) throw new Error(p.reason); return p; })();

  it('refunds add up exactly to the leftover, none is negative, and putting in strictly more never gets you less back', () => {
    const r = rng(5);
    for (let i = 0; i < CASES; i++) {
      const funding = checkFunding(plan, randomDeposits(r, plan.revision));
      const purchases: Purchase[] = Array.from({ length: int(r, 0, 5) }, (_, k) => ({ id: `p${k}`, amountDollars: int(r, 0, 200), category: 'food' }));
      const s = settleTrip(plan, funding, spendVsPlan(plan, purchases));
      expect(s.leftoverDollars).toBe(funding.collectedDollars - s.spentDollars);
      if (s.leftoverDollars > 0 && funding.collectedDollars > 0) {
        expect(s.refunds.reduce((t, x) => t + x.dollars, 0)).toBe(s.leftoverDollars);
        for (const x of s.refunds) expect(x.dollars).toBeGreaterThan(0);
        const paid = (id: string) => funding.perMember.find((m) => m.memberId === id)!.paidDollars;
        const got = (id: string) => s.refunds.find((x) => x.memberId === id)?.dollars ?? 0;
        for (const a of ids) {
          for (const b of ids) {
            if (paid(a) > paid(b)) expect(got(a)).toBeGreaterThanOrEqual(got(b));
            // One dollar cannot be split, so people who put in exactly the same can differ by at most that dollar.
            if (paid(a) === paid(b)) expect(Math.abs(got(a) - got(b))).toBeLessThanOrEqual(1);
          }
        }
      } else {
        expect(s.refunds).toEqual([]);
      }
      if (s.shortfall) expect(s.shortfall.perMember.reduce((t, x) => t + x.dollars, 0)).toBeGreaterThanOrEqual(s.shortfall.dollars);
    }
  });
});

describe('spendVsPlan', () => {
  const plan = (() => { const p = planContributions(approvedWith(45_000, 3_000)); if (!p.ok) throw new Error(p.reason); return p; })();

  it('counts every completed dollar exactly once, split between categories and unclassified', () => {
    const r = rng(6);
    const names = ['food', 'gas', 'accommodation', 'parks', 'nonsense', undefined];
    for (let i = 0; i < CASES; i++) {
      const purchases: Purchase[] = Array.from({ length: int(r, 0, 10) }, (_, k) => ({ id: `p${k}`, amountDollars: int(r, 0, 500), category: names[int(r, 0, names.length - 1)], ...(r() < 0.2 ? { status: 'pending' } : {}) }));
      const report = spendVsPlan(plan, purchases);
      const counted = purchases.filter((p) => p.status === undefined).reduce((t, p) => t + p.amountDollars, 0);
      expect(report.totalSpentDollars).toBe(counted);
      expect(report.byCategory.reduce((t, c) => t + c.spentDollars, 0) + report.unclassifiedDollars).toBe(counted);
      expect(spendVsPlan(plan, shuffle(r, purchases))).toEqual(report);
    }
  });
});
