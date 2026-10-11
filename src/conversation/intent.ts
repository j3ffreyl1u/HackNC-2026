import type { ConstraintValue } from './contracts-local.js';
import { parseMaxTravelMinutes } from './constraints.js';
import { isValidIsoDate, parseDollarsToCents } from './money.js';

export type ValidIntent =
  | { intent: 'constraints'; items: ConstraintValue[] }
  | { intent: 'request_plans' }
  | { intent: 'ask_guide'; question: string }
  /** Chooses one of the numbered options on offer (1-based). Whether that is allowed is decided by the parser. */
  | { intent: 'pick'; choice: number }
  | { intent: 'request_funding' }
  | { intent: 'yes' }
  | { intent: 'no' }
  | { intent: 'clarify' }
  /** A casual question the model answered from the facts it was given. Checked by safeChatAnswer before it is sent. */
  | { intent: 'chat'; answer: string }
  /** The language service did not answer (quota, outage, timeout). Not the same as "I couldn't tell what you meant". */
  | { intent: 'unavailable' }
  | { intent: 'none' };

const SIMPLE = new Set(['request_plans', 'request_funding', 'yes', 'no', 'none', 'unavailable']);
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
      const text = str(o.text, 60)?.replace(/^the\s+/i, '');
      return text ? { field: 'origin', value: text } : null;
    }
    case 'region': {
      const text = str(o.text, 60)?.replace(/^the\s+/i, '');   // "the NC mountains" is searched as "NC mountains"
      if (!text) return null;
      // "somewhere warm" is a wish, not a place: keep it as something they like instead of searching for a town of that name.
      const vague = /^(?:somewhere|anywhere|someplace|any\s*place|a\s+place)\s*(.*)$/i.exec(text);
      if (vague) {
        const rest = vague[1]!.replace(/^(?:that'?s|that is|with|near|like)\s+/i, '').trim().toLowerCase();
        if (!rest) return null;
        return { field: 'preferences', value: [/^(?:warm|warmer|hot|cold|cool|sunny)$/.test(rest) ? `${rest} weather` : rest] };
      }
      const given = o.maxTravelMinutes;
      const minutes = typeof given === 'number' && Number.isInteger(given) && given >= 15 && given <= 1440 ? given : parseMaxTravelMinutes(text);
      return { field: 'region', value: text, ...(minutes !== undefined ? { maxTravelMinutes: minutes } : {}) };
    }
    case 'transport': {
      const text = str(o.text, 60);
      if (!text) return null;
      // The model sometimes leaves the yes/no out ("Mason has one"); read it from the words rather than ask again.
      if (/\b(?:fly|flying|flight|flights|plane|airplane)\b/i.test(text) && !/\b(?:don'?t|not|no)\s+(?:want\s+to\s+)?(?:fly|flying|plane)/i.test(text)) return { field: 'transport', value: 'plane', vehicleAvailable: false };
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
  if (kind === 'chat') {
    const a = str(o.answer, 400);
    return a ? { intent: 'chat', answer: a } : { intent: 'clarify' };
  }
  if (kind === 'pick') {
    const n = typeof o.choice === 'string' && /^\d+$/.test(o.choice.trim()) ? Number(o.choice) : o.choice;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 9 ? { intent: 'pick', choice: n } : { intent: 'clarify' };
  }
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

/**
 * A model-written reply to a casual question is only sent if it stays inside what it was given: no dollar sign, no number
 * that is not in the facts or the question, no em dash, short, and no leftover markup. Otherwise the caller sends plain help.
 */
export function safeChatAnswer(answer: string, allowedText: string): string | null {
  const text = answer.trim();
  if (!text || text.length > 400 || /\u2014|\u2013|[*_`#<>]/.test(text) || /shout if that'?s off/i.test(text) || /\bfacts\b/i.test(text)) return null;
  // A dollar amount may only be one that is written in the facts or the message itself (an option's price), never an invented or private one.
  const amounts = (t: string) => (t.match(/\$\s?\d(?:[\d,]*\d)?(?:\.\d+)?/g) ?? []).map((a) => a.replace(/\s/g, ''));
  const allowedAmounts = new Set(amounts(allowedText));
  // "which is cheaper and by how much?": the gap between two prices that are written in the facts is fine to say.
  const figures = [...allowedAmounts].map((a) => Number(a.replace(/[$,]/g, '')));
  const gaps = new Set<number>();
  for (const x of figures) for (const y of figures) if (x > y) gaps.add(x - y);
  const isGap = (a: string) => gaps.has(Number(a.replace(/[$,]/g, '')));
  if (amounts(text).some((a) => !allowedAmounts.has(a) && !isGap(a))) return null;
  const digits = (t: string) => t.match(/\d+/g) ?? [];
  const allowed = new Set(digits(allowedText));
  const gapDigits = new Set(amounts(text).filter(isGap).flatMap((a) => digits(a)));
  if (digits(text).some((d) => !allowed.has(d) && !gapDigits.has(d))) return null;
  if ((text.match(/[.!?](?:\s|$)/g) ?? []).length > 3) return null;
  return text;
}
