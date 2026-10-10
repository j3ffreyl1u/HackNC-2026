import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  addCents,
  addRanges,
  assertCents,
  assertPositiveCents,
  formatUsd,
  makeRange,
  splitEqual,
  splitRange,
  sumCents,
  sumRanges,
} from '../../src/planning/money.js';

const people = ['mason', 'alex', 'jordan'];

describe('cent validation', () => {
  it('accepts whole non-negative cents, including zero', () => {
    expect(() => assertCents(0)).not.toThrow();
    expect(() => assertCents(18_000)).not.toThrow();
  });

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '100' as unknown as number])(
    'rejects %s',
    (value) => {
      expect(() => assertCents(value)).toThrow(MoneyError);
    },
  );

  it('positive amounts exclude zero', () => {
    expect(() => assertPositiveCents(1)).not.toThrow();
    expect(() => assertPositiveCents(0, 'budget')).toThrow(/budget must be greater than zero/);
  });

  it('addition never leaves the safe-integer range', () => {
    expect(addCents(1_000, 2_000)).toBe(3_000);
    expect(() => addCents(Number.MAX_SAFE_INTEGER, 1)).toThrow(MoneyError);
    expect(sumCents([100, 200, 300])).toBe(600);
    expect(sumCents([])).toBe(0);
  });
});

describe('ranges', () => {
  it('builds and adds ranges exactly', () => {
    expect(makeRange(100, 200)).toEqual({ lowCents: 100, highCents: 200 });
    expect(makeRange(500, 500)).toEqual({ lowCents: 500, highCents: 500 });
    expect(addRanges(makeRange(100, 200), makeRange(10, 20))).toEqual({ lowCents: 110, highCents: 220 });
    expect(sumRanges([makeRange(1, 2), makeRange(3, 4), makeRange(5, 6)])).toEqual({ lowCents: 9, highCents: 12 });
    expect(sumRanges([])).toEqual({ lowCents: 0, highCents: 0 });
  });

  it('rejects a low estimate above the high estimate and bad amounts', () => {
    expect(() => makeRange(200, 100)).toThrow(/must not exceed/);
    expect(() => makeRange(-1, 100)).toThrow(MoneyError);
    expect(() => makeRange(1, 1.5)).toThrow(MoneyError);
  });
});

describe('splitEqual', () => {
  it('splits the acceptance-fixture shared costs exactly', () => {
    expect(splitEqual(48_000, people)).toEqual({ mason: 16_000, alex: 16_000, jordan: 16_000 });
    expect(splitEqual(45_000, people)).toEqual({ mason: 15_000, alex: 15_000, jordan: 15_000 });
    expect(splitEqual(3_000, people)).toEqual({ mason: 1_000, alex: 1_000, jordan: 1_000 });
  });

  it('gives remainder cents to the earliest people in the order given', () => {
    expect(splitEqual(100, people)).toEqual({ mason: 34, alex: 33, jordan: 33 });
    expect(splitEqual(101, people)).toEqual({ mason: 34, alex: 34, jordan: 33 });
    expect(splitEqual(100, ['jordan', 'alex', 'mason'])).toEqual({ jordan: 34, alex: 33, mason: 33 });
  });

  it('always sums exactly to the total, for many totals and group sizes', () => {
    for (let n = 1; n <= 7; n++) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      for (let total = 0; total < 300; total++) {
        const parts = Object.values(splitEqual(total, ids));
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rejects bad totals, empty groups and duplicate people', () => {
    expect(() => splitEqual(10.5, people)).toThrow(MoneyError);
    expect(() => splitEqual(-1, people)).toThrow(MoneyError);
    expect(() => splitEqual(100, [])).toThrow(/at least one/);
    expect(() => splitEqual(100, ['a', 'a'])).toThrow(/unique/);
  });

  it('splits a range end by end', () => {
    expect(splitRange(makeRange(100, 101), people)).toEqual({
      mason: { lowCents: 34, highCents: 34 },
      alex: { lowCents: 33, highCents: 34 },
      jordan: { lowCents: 33, highCents: 33 },
    });
  });
});

describe('formatUsd', () => {
  it('formats cents for messages', () => {
    expect([0, 5, 100, 18_000, 1_234_567].map(formatUsd)).toEqual(['$0.00', '$0.05', '$1.00', '$180.00', '$12,345.67']);
    expect(() => formatUsd(1.5)).toThrow(MoneyError);
  });
});
