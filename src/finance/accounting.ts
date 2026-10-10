// Pure cent arithmetic. No I/O, no clock, no floating point.

export class AccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountingError';
  }
}

export function assertCents(value: number, label = 'amount'): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AccountingError(`${label} must be an integer number of cents`);
  }
  if (value < 0) {
    throw new AccountingError(`${label} must not be negative`);
  }
}

/**
 * Equal split of a total across members. Any remainder cents go one each to the
 * earliest members in the given (stable, configured) order: 100 / 3 -> 34, 33, 33.
 */
export function splitEqual(totalCents: number, memberIds: readonly string[]): Record<string, number> {
  assertCents(totalCents, 'total');
  if (memberIds.length === 0) throw new AccountingError('at least one member is required');
  if (new Set(memberIds).size !== memberIds.length) throw new AccountingError('member IDs must be unique');

  const base = Math.floor(totalCents / memberIds.length);
  const remainder = totalCents - base * memberIds.length;
  const shares: Record<string, number> = {};
  memberIds.forEach((id, index) => {
    shares[id] = base + (index < remainder ? 1 : 0);
  });
  return shares;
}

export interface CarryoverDebt {
  debtId: string;
  debtorId: string;
  creditorId: string;
  /** Remaining debt net of credit already reserved by another pending settlement. */
  remainingCents: number;
}

export interface CarryoverApplication {
  debtId: string;
  debtorId: string;
  creditorId: string;
  /** Credit applied against the creditor's share this cycle. */
  appliedCents: number;
  /** Credit not used because the creditor's share was already covered. */
  retainedCents: number;
}

export interface CarryoverPlan {
  /** What each member is asked to contribute for the cycle. Never negative. */
  requests: Record<string, number>;
  applications: CarryoverApplication[];
}

/**
 * Plan next-cycle requests. The creditor's share is reduced by the credit and the
 * debtor is asked for their own share plus the same amount, so the total still equals
 * the sum of shares. Credit above the creditor's remaining share is retained rather
 * than creating a negative request. This is a preview: it settles nothing.
 */
export function planCarryover(shares: Record<string, number>, debts: readonly CarryoverDebt[]): CarryoverPlan {
  const requests: Record<string, number> = {};
  for (const [id, share] of Object.entries(shares)) {
    assertCents(share, `share for ${id}`);
    requests[id] = share;
  }
  const creditorRoom: Record<string, number> = { ...requests };
  const applications: CarryoverApplication[] = [];

  for (const debt of debts) {
    assertCents(debt.remainingCents, `debt ${debt.debtId}`);
    if (!(debt.debtorId in shares) || !(debt.creditorId in shares)) {
      throw new AccountingError(`debt ${debt.debtId} references a member outside the cycle`);
    }
    if (debt.debtorId === debt.creditorId) {
      throw new AccountingError(`debt ${debt.debtId} has the same debtor and creditor`);
    }
    const appliedCents = Math.min(debt.remainingCents, creditorRoom[debt.creditorId]);
    creditorRoom[debt.creditorId] -= appliedCents;
    requests[debt.creditorId] -= appliedCents;
    requests[debt.debtorId] += appliedCents;
    applications.push({
      debtId: debt.debtId,
      debtorId: debt.debtorId,
      creditorId: debt.creditorId,
      appliedCents,
      retainedCents: debt.remainingCents - appliedCents,
    });
  }
  return { requests, applications };
}
