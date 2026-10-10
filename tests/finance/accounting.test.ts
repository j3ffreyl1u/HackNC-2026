import { describe, expect, it } from 'vitest';
import { AccountingError, planCarryover, splitEqual } from '../../src/finance/accounting.js';

const members = ['mason', 'alex', 'jordan'];

describe('splitEqual', () => {
  it('splits the October electricity bill into three 4,800 shares', () => {
    expect(splitEqual(14_400, members)).toEqual({ mason: 4_800, alex: 4_800, jordan: 4_800 });
  });

  it('splits the November bill evenly', () => {
    expect(splitEqual(15_000, members)).toEqual({ mason: 5_000, alex: 5_000, jordan: 5_000 });
  });

  it('gives remainder cents to the earliest members in stable order: 100 -> 34/33/33', () => {
    expect(splitEqual(100, members)).toEqual({ mason: 34, alex: 33, jordan: 33 });
    expect(splitEqual(101, members)).toEqual({ mason: 34, alex: 34, jordan: 33 });
  });

  it('always sums exactly to the total', () => {
    for (let total = 0; total < 500; total++) {
      const sum = Object.values(splitEqual(total, members)).reduce((a, b) => a + b, 0);
      expect(sum).toBe(total);
    }
  });

  it('rejects non-integer, negative and unsafe amounts', () => {
    expect(() => splitEqual(10.5, members)).toThrow(AccountingError);
    expect(() => splitEqual(-1, members)).toThrow(AccountingError);
    expect(() => splitEqual(Number.NaN, members)).toThrow(AccountingError);
    expect(() => splitEqual(Number.POSITIVE_INFINITY, members)).toThrow(AccountingError);
    expect(() => splitEqual(Number.MAX_SAFE_INTEGER + 1, members)).toThrow(AccountingError);
  });

  it('rejects empty or duplicate member lists', () => {
    expect(() => splitEqual(100, [])).toThrow(AccountingError);
    expect(() => splitEqual(100, ['a', 'a'])).toThrow(AccountingError);
  });
});

describe('planCarryover', () => {
  const novemberShares = splitEqual(15_000, members);
  const debt = { debtId: 'debt-1', debtorId: 'jordan', creditorId: 'alex', remainingCents: 4_800 };

  it('with no debt, requests equal the shares', () => {
    const plan = planCarryover(novemberShares, []);
    expect(plan.requests).toEqual({ mason: 5_000, alex: 5_000, jordan: 5_000 });
    expect(plan.applications).toEqual([]);
  });

  it('reproduces the canonical November requests: Mason 5,000, Alex 200, Jordan 9,800', () => {
    const plan = planCarryover(novemberShares, [debt]);
    expect(plan.requests).toEqual({ mason: 5_000, alex: 200, jordan: 9_800 });
    expect(plan.applications).toEqual([
      { debtId: 'debt-1', debtorId: 'jordan', creditorId: 'alex', appliedCents: 4_800, retainedCents: 0 },
    ]);
  });

  it('keeps the total of requests equal to the total of shares', () => {
    const plan = planCarryover(novemberShares, [debt]);
    const total = Object.values(plan.requests).reduce((a, b) => a + b, 0);
    expect(total).toBe(15_000);
  });

  it('is a pure preview: the input debt is not modified', () => {
    planCarryover(novemberShares, [debt]);
    expect(debt.remainingCents).toBe(4_800);
  });

  it('retains unused credit instead of creating a negative request', () => {
    const plan = planCarryover({ mason: 1_000, alex: 1_000, jordan: 1_000 }, [debt]);
    expect(plan.requests).toEqual({ mason: 1_000, alex: 0, jordan: 2_000 });
    expect(plan.applications[0]).toMatchObject({ appliedCents: 1_000, retainedCents: 3_800 });
    expect(Object.values(plan.requests).every((cents) => cents >= 0)).toBe(true);
  });

  it('does not apply the same creditor room twice across several debts', () => {
    const second = { debtId: 'debt-2', debtorId: 'mason', creditorId: 'alex', remainingCents: 4_800 };
    const plan = planCarryover(novemberShares, [debt, second]);
    // Alex's 5,000 share can absorb 5,000 of credit in total, not 9,600.
    const applied = plan.applications.reduce((sum, a) => sum + a.appliedCents, 0);
    expect(applied).toBe(5_000);
    expect(plan.requests.alex).toBe(0);
    expect(plan.applications[1]).toMatchObject({ appliedCents: 200, retainedCents: 4_600 });
    expect(Object.values(plan.requests).reduce((a, b) => a + b, 0)).toBe(15_000);
  });

  it('rejects debts for unknown members, self-debts and invalid amounts', () => {
    expect(() => planCarryover(novemberShares, [{ ...debt, debtorId: 'ghost' }])).toThrow(AccountingError);
    expect(() => planCarryover(novemberShares, [{ ...debt, creditorId: 'jordan' }])).toThrow(AccountingError);
    expect(() => planCarryover(novemberShares, [{ ...debt, remainingCents: -1 }])).toThrow(AccountingError);
    expect(() => planCarryover(novemberShares, [{ ...debt, remainingCents: 1.5 }])).toThrow(AccountingError);
  });
});
