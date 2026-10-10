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
