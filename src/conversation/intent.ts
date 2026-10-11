import type { ConstraintValue } from './contracts-local.js';
import { parseMaxTravelMinutes } from './constraints.js';
import { isValidIsoDate, parseDollarsToCents } from './money.js';

export type ValidIntent =
  | { intent: 'constraints'; items: ConstraintValue[] }
  | { intent: 'request_plans' }
  | { intent: 'ask_guide'; question: string }
  | { intent: 'request_funding' }
  | { intent: 'yes' }
  | { intent: 'no' }
  | { intent: 'clarify' }
  | { intent: 'none' };

const SIMPLE = new Set(['request_plans', 'request_funding', 'yes', 'no', 'none']);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
const list = (v: unknown): string[] | null => {
  if (!Array.isArray(v) || v.length > 10) return null;
  const out = v.map((x) => str(x, 60));
  return out.every((x): x is string => x !== null) ? [...new Set(out)] : null;
};

/** Validates one model-proposed constraint. Anything malformed is dropped, never repaired. */
export function validateConstraintItem(raw: unknown): ConstraintValue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  switch (o.field) {
    case 'budget': {
      const cents = typeof o.amount === 'string' || typeof o.amount === 'number' ? parseDollarsToCents(o.amount) : null;
      return cents === null ? null : { field: 'budget', value: cents };
    }
    case 'availability': {
      if (!Array.isArray(o.windows) || o.windows.length === 0 || o.windows.length > 6) return null;
      const windows = [];
      for (const w of o.windows as Array<Record<string, unknown>>) {
        const start = typeof w?.start === 'string' ? w.start : '';
        const end = typeof w?.end === 'string' ? w.end : '';
        if (!isValidIsoDate(start) || !isValidIsoDate(end) || end < start) return null;
        windows.push({ start, end });
      }
      return { field: 'availability', value: windows };
    }
    case 'preferences':
    case 'must_dos': {
      const values = list(o.values);
      return values ? { field: o.field, value: values } : null;
    }
    case 'origin': {
      const text = str(o.text, 60);
      return text ? { field: 'origin', value: text } : null;
    }
    case 'region': {
      const text = str(o.text, 60);
      if (!text) return null;
      const given = o.maxTravelMinutes;
      const minutes = typeof given === 'number' && Number.isInteger(given) && given >= 15 && given <= 1440 ? given : parseMaxTravelMinutes(text);
      return { field: 'region', value: text, ...(minutes !== undefined ? { maxTravelMinutes: minutes } : {}) };
    }
    case 'transport': {
      const text = str(o.text, 60);
      if (!text) return null;
      // The model sometimes leaves the yes/no out ("Mason has one"); read it from the words rather than ask again.
      const has = typeof o.vehicleAvailable === 'boolean' ? o.vehicleAvailable : /\b(?:no|nobody|none|don'?t|doesn'?t|without|neither)\b/i.test(text) ? false : /\b(?:has|have|got|own|owns|car|truck|suv|van|vehicle|drive|ride|one)\b/i.test(text) ? true : undefined;
      return { field: 'transport', value: text, ...(has !== undefined ? { vehicleAvailable: has } : {}) };
    }
    case 'duration': {
      const n = o.nights;
      return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 30 ? { field: 'duration', value: n } : null;
    }
    default:
      return null;
  }
}

/**
 * Validates untrusted model output. Malformed output becomes a clarification or nothing, never a command
 * with invented values. Certainty, actor and permissions are decided by ordinary code, not the model.
 */
export function validateIntent(raw: unknown): ValidIntent {
  if (typeof raw !== 'object' || raw === null) return { intent: 'clarify' };
  const o = raw as Record<string, unknown>;
  const kind = o.intent;
  if (typeof kind !== 'string') return { intent: 'clarify' };
  if (SIMPLE.has(kind)) return { intent: kind } as ValidIntent;
  if (kind === 'ask_guide') {
    const q = str(o.question, 500);
    return q ? { intent: 'ask_guide', question: q } : { intent: 'clarify' };
  }
  if (kind === 'constraints') {
    const items = (Array.isArray(o.items) ? o.items : []).map(validateConstraintItem).filter((x): x is ConstraintValue => x !== null);
    return items.length ? { intent: 'constraints', items } : { intent: 'clarify' };
  }
  return { intent: 'clarify' };
}
