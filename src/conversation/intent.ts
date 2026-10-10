import { isValidIsoDate, parseDollarsToCents } from './money.js';

export type ValidIntent =
  | { intent: 'add_bill'; amountCents: number; title: string; dueDate: string }
  | { intent: 'correct_bill'; amountCents: number; title: string; dueDate: string }
  | { intent: 'summary' }
  | { intent: 'request_coverage' }
  | { intent: 'offer_coverage'; amountCents?: number }
  | { intent: 'approve' }
  | { intent: 'decline' }
  | { intent: 'consent_yes' }
  | { intent: 'consent_no' }
  | { intent: 'clarify'; reason: 'unclear_amount' | 'missing_field' | 'unclear' }
  | { intent: 'none' };

const SIMPLE = new Set(['summary', 'request_coverage', 'approve', 'decline', 'consent_yes', 'consent_no', 'none']);

/**
 * Validates untrusted model output. Anything malformed becomes a clarification,
 * never a money-moving intent. Amounts must be decimal dollar strings or numbers
 * with at most two decimals.
 */
export function validateIntent(raw: unknown): ValidIntent {
  if (typeof raw !== 'object' || raw === null) return { intent: 'clarify', reason: 'unclear' };
  const o = raw as Record<string, unknown>;
  const kind = o.intent;
  if (typeof kind !== 'string') return { intent: 'clarify', reason: 'unclear' };
  if (SIMPLE.has(kind)) return { intent: kind } as ValidIntent;

  if (kind === 'offer_coverage') {
    if (o.amount === undefined || o.amount === null) return { intent: 'offer_coverage' };
    const cents = typeof o.amount === 'string' || typeof o.amount === 'number' ? parseDollarsToCents(o.amount) : null;
    return cents === null ? { intent: 'clarify', reason: 'unclear_amount' } : { intent: 'offer_coverage', amountCents: cents };
  }

  if (kind === 'add_bill' || kind === 'correct_bill') {
    const cents = typeof o.amount === 'string' || typeof o.amount === 'number' ? parseDollarsToCents(o.amount) : null;
    if (cents === null) return { intent: 'clarify', reason: 'unclear_amount' };
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 60) : '';
    const dueDate = typeof o.dueDate === 'string' ? o.dueDate.trim() : '';
    if (!title || !isValidIsoDate(dueDate)) return { intent: 'clarify', reason: 'missing_field' };
    return { intent: kind, amountCents: cents, title, dueDate };
  }
  return { intent: 'clarify', reason: 'unclear' };
}
