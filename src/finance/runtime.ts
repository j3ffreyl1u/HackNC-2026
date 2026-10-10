// Small shared primitives for the finance modules (kept separate to avoid import cycles).

export interface Clock {
  now(): Date;
}

/** Produces unique IDs; the prefix names the kind of entity (e.g. `prop`, `op`). */
export type IdGenerator = (prefix: string) => string;

/** Invalid enrollment or seeding configuration: an operator error, not a user-facing domain rejection. */
export class FinanceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinanceConfigError';
  }
}

/** A service method whose milestone has not been built yet. Never reports success. */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`${method} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

export type CycleTransitionReason =
  | 'unknown_household'
  | 'unknown_cycle'
  | 'not_next'
  | 'prior_unpaid'
  | 'unresolved_operations';

/** The requested demo cycle change is not allowed right now. The app maps this to HTTP 409. */
export class CycleTransitionError extends Error {
  constructor(
    readonly reason: CycleTransitionReason,
    message: string,
  ) {
    super(message);
    this.name = 'CycleTransitionError';
  }
}
