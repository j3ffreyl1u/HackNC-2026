// Exact money arithmetic for planning. Amounts are safe-integer USD cents; nothing here uses floats.

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export interface CentRange {
  lowCents: number;
  highCents: number;
}

/** A non-negative whole number of cents. Zero is a real price (free); unknown is modelled elsewhere. */
export function assertCents(value: number, label = 'amount'): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a whole number of cents`);
  }
  if (value < 0) throw new MoneyError(`${label} must not be negative`);
}

export function assertPositiveCents(value: number, label = 'amount'): void {
  assertCents(value, label);
  if (value === 0) throw new MoneyError(`${label} must be greater than zero`);
}

/** Add without ever leaving the safe-integer range. */
export function addCents(a: number, b: number): number {
  assertCents(a);
  assertCents(b);
  const total = a + b;
  if (!Number.isSafeInteger(total)) throw new MoneyError('amount is too large');
  return total;
}

export function sumCents(values: readonly number[]): number {
  return values.reduce((total, value) => addCents(total, value), 0);
}

export function makeRange(lowCents: number, highCents: number): CentRange {
  assertCents(lowCents, 'low estimate');
  assertCents(highCents, 'high estimate');
  if (lowCents > highCents) throw new MoneyError('low estimate must not exceed the high estimate');
  return { lowCents, highCents };
}

export function addRanges(a: CentRange, b: CentRange): CentRange {
  return { lowCents: addCents(a.lowCents, b.lowCents), highCents: addCents(a.highCents, b.highCents) };
}

export function sumRanges(ranges: readonly CentRange[]): CentRange {
  return ranges.reduce(addRanges, { lowCents: 0, highCents: 0 });
}

/**
 * Split a total equally. Any remainder goes one cent each to the earliest IDs in the order given, so the
 * parts always sum exactly to the total and the result never depends on object or locale ordering.
 */
export function splitEqual(totalCents: number, ids: readonly string[]): Record<string, number> {
  assertCents(totalCents, 'total');
  if (ids.length === 0) throw new MoneyError('at least one person is required');
  if (new Set(ids).size !== ids.length) throw new MoneyError('people must be unique');

  const base = Math.floor(totalCents / ids.length);
  const remainder = totalCents - base * ids.length;
  const shares: Record<string, number> = {};
  ids.forEach((id, index) => {
    shares[id] = base + (index < remainder ? 1 : 0);
  });
  return shares;
}

/** Split a low/high range, splitting each end independently with the same remainder rule. */
export function splitRange(range: CentRange, ids: readonly string[]): Record<string, CentRange> {
  const low = splitEqual(range.lowCents, ids);
  const high = splitEqual(range.highCents, ids);
  return Object.fromEntries(ids.map((id) => [id, { lowCents: low[id], highCents: high[id] }]));
}

/** "$180.00" style text for messages. Never used for arithmetic. */
export function formatUsd(cents: number): string {
  assertCents(cents);
  const dollars = Math.floor(cents / 100);
  return `$${dollars.toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
}

/** "$135": whole dollars, rounded up, for chat messages where cents only add noise. */
export function formatUsdWhole(cents: number): string {
  assertCents(cents);
  return `$${Math.ceil(cents / 100).toLocaleString('en-US')}`;
}
