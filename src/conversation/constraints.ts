import type { ConstraintField, ConstraintValue } from './contracts-local.js';
import { parseDateWindows } from './dates.js';
import { parseDollarsToCents } from './money.js';

/** Tentative language never becomes a locked-in budget or date window. */
export const HEDGE = /\b(maybe|might|perhaps|possibly|probably|not sure|i guess|i think|could|what if|if i|if we|would|ish|depends|hopefully|tentatively)\b|\?/i;

export interface Extracted {
  value: ConstraintValue;
  /** The sentence it came from used tentative or question wording. */
  hedged: boolean;
  /** Availability sentence was negative ("can't do Oct 17"): not a window. Reported so the bot can ask. */
  negative?: boolean;
}

const MONEY = '\\$\\s*([\\d,]+(?:\\.\\d{1,2})?)|([\\d,]+(?:\\.\\d{1,2})?)\\s*(?:dollars|bucks|usd)';
const BUDGET_KEYWORD = '(?:budget|max(?:imum)?|cap|limit|spend|afford|up to|at most|no more than|can do|can pay|can swing|all[- ]in)';
const BUDGET_AFTER = new RegExp(`\\b${BUDGET_KEYWORD}\\b[^.!?\\n$\\d]{0,30}?(?:${MONEY})`, 'i');
const BUDGET_BEFORE = new RegExp(`(?:${MONEY})\\s*(?:max|total|tops|cap|limit|all[- ]in|budget|at most)\\b`, 'i');
const BUDGET_BARE = /\b(?:budget|max(?:imum)?|cap|limit)\b\s*(?:is|of|:|=|around|about)?\s*([\d,]+(?:\.\d{1,2})?)\b(?!\s*[a-z])/i;
const BARE_AMOUNT = /^\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)?[.!]*$/i;
const AVAIL_WORDS = /\b(free|available|availability|open|works?|can (?:do|go|make(?: it)?|leave)|good|window|off)\b/i;
const NEGATIVE = /\b(not|n't|busy|can'?t|cannot|unavailable|booked|out of town)\b/i;

/** One-way drive limit in minutes from text like "within 3 hours", "1.5 hour drive", "within 90 minutes". */
export function parseMaxTravelMinutes(text: string): number | undefined {
  let m: RegExpExecArray | null;
  let minutes: number | undefined;
  if ((m = /\b(\d{1,2}(?:\.\d)?)\s*[- ]?(?:hours?|hrs?|h)\b/i.exec(text))) minutes = Math.round(Number(m[1]) * 60);
  else if ((m = /\b(\d{2,3})\s*[- ]?(?:minutes?|mins?)\b/i.exec(text))) minutes = Number(m[1]);
  return minutes !== undefined && minutes >= 15 && minutes <= 1440 ? minutes : undefined;
}

const clean = (s: string) => s.trim().replace(/^(?:a|an|the|some)\s+/i, '').replace(/[.!,;]+$/, '').trim();
const GENERIC = /^(?:that|it|this|those|these|them|the idea|to|doing)\b/i;

function splitItems(raw: string): string[] {
  const items = raw
    .split(/\s*(?:,|&|\band\b|\bor\b)\s*/i)
    .map(clean)
    .filter((s) => s.length > 1 && s.length <= 60 && !GENERIC.test(s));
  return [...new Set(items)].slice(0, 10);
}

function budgetFrom(sentence: string): number | null {
  const m = BUDGET_AFTER.exec(sentence) ?? BUDGET_BEFORE.exec(sentence);
  const raw = m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : BUDGET_BARE.exec(sentence)?.[1];
  return raw ? parseDollarsToCents(raw) : null;
}

function extractSentence(s: string, reference: string, pending: ConstraintField | undefined, out: Extracted[]): void {
  const hedged = HEDGE.test(s);
  const push = (value: ConstraintValue, extra: Partial<Extracted> = {}) => out.push({ value, hedged, ...extra });
  let m: RegExpExecArray | null;

  const cents = budgetFrom(s);
  if (cents !== null) push({ field: 'budget', value: cents });

  const windows = parseDateWindows(s, reference);
  if (windows.length && (AVAIL_WORDS.test(s) || pending === 'availability' || NEGATIVE.test(s))) {
    if (NEGATIVE.test(s) && !/\b(free|available)\b/i.test(s.replace(/\b(not|n't) (free|available)/gi, ''))) push({ field: 'availability', value: windows }, { negative: true });
    else push({ field: 'availability', value: windows });
  }

  if ((m = /\b(\d{1,2})\s*[- ]?nights?\b/i.exec(s))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 30) push({ field: 'duration', value: n });
  }
  if ((m = /\b(?:leav(?:e|ing)|depart(?:ing)?|start(?:ing)?|driv(?:e|ing)|coming|going)\s+from\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=[,.;!?]|\s+(?:and|but|on|at|around|with|to|for|in|if)\b|$)/i.exec(s)) ?? (m = /\b(?:origin|departing city)\s*(?:is|:)\s*([A-Za-z][A-Za-z .'-]{1,40})/i.exec(s))) {
    push({ field: 'origin', value: m![1]!.trim() });
  }
  if ((m = /\bwithin\s+(?:about\s+|around\s+)?(\d{1,2}(?:\.\d)?)\s*(?:hours?|hrs?|h)\b/i.exec(s)) ?? (m = /\b(\d{1,2}(?:\.\d)?)\s*[- ]?(?:hours?|hrs?)\s+(?:drive|away|radius)\b/i.exec(s))) {
    push({ field: 'region', value: `within ${m![1]} hours by car`, maxTravelMinutes: Math.round(Number(m![1]) * 60) });
  } else if ((m = /\b(?:destination|region|area)\s*(?:is|:)\s*([A-Za-z][A-Za-z ,.'-]{1,40})/i.exec(s))) {
    const value = clean(m[1]!);
    const maxTravelMinutes = parseMaxTravelMinutes(value);
    push({ field: 'region', value, ...(maxTravelMinutes !== undefined ? { maxTravelMinutes } : {}) });
  }
  if (/\bi\s+(?:have|got)\s+(?:a\s+|my\s+)?(?:own\s+)?(?:car|vehicle|truck|suv)\b|\bi\s+can\s+drive\b|\bi(?:'ll| will)\s+drive\b/i.test(s)) push({ field: 'transport', value: 'own_vehicle', vehicleAvailable: true });
  else if (/\bi\s+(?:don'?t|do not)\s+have\s+(?:a\s+)?(?:car|vehicle)\b|\bno car\b/i.test(s)) push({ field: 'transport', value: 'no_vehicle', vehicleAvailable: false });

  if (/\b(?:no (?:real )?preferences?|don'?t (?:really )?care|i'?m (?:easy|flexible|open to anything))\b/i.test(s)) {
    push({ field: 'preferences', value: ['no preference'] });
  } else if ((m = /\b(?:i|we)\s+(?:really\s+)?(?:prefer|like|love|enjoy|(?:am|'m)\s+into|want to (?:do|go|try|see))\s+(.+)$/i.exec(s))) {
    const items = splitItems(m[1]!.split(/\b(?:but|so|because)\b/i)[0]!);
    if (items.length) push({ field: 'preferences', value: items });
  }
  const musts: string[] = [];
  if ((m = /\b(?:must(?:[- ]do| see| have| include)|have to (?:do|see)|need to (?:do|see)|can'?t miss|dealbreaker)\s*:?\s+(.+)$/i.exec(s))) musts.push(...splitItems(m[1]!));
  if ((m = /\bi(?:'m| am)\s+(vegetarian|vegan|gluten[- ]free|lactose intolerant|pescatarian)\b/i.exec(s))) musts.push(m[1]!.toLowerCase());
  if ((m = /\b(halal|kosher|wheelchair|step[- ]free)\b/i.exec(s))) musts.push(m[1]!.toLowerCase());
  if (musts.length) push({ field: 'must_dos', value: [...new Set(musts)].slice(0, 10) });
}

/** Answers to the question we last asked this member: a bare "200", "2", "Chapel Hill". */
function pendingAnswer(text: string, reference: string, pending: ConstraintField): Extracted | null {
  const t = text.trim();
  const hedged = HEDGE.test(t);
  let m: RegExpExecArray | null;
  switch (pending) {
    case 'budget': {
      const bare = t.replace(new RegExp(HEDGE.source, 'gi'), ' ').replace(/\s+/g, ' ').trim();
      const cents = (m = BARE_AMOUNT.exec(bare)) ? parseDollarsToCents(m[1]!) : null;
      return cents === null ? null : { value: { field: 'budget', value: cents }, hedged };
    }
    case 'duration':
      return (m = /^(\d{1,2})\s*(?:nights?)?[.!]*$/i.exec(t)) && Number(m[1]) >= 1 && Number(m[1]) <= 30 ? { value: { field: 'duration', value: Number(m[1]) }, hedged } : null;
    case 'origin':
    case 'region':
      return /^[A-Za-z][A-Za-z ,.'-]{1,40}$/.test(t) && !hedged ? { value: { field: pending, value: t.replace(/[.!]+$/, '') }, hedged } : null;
    case 'preferences':
    case 'must_dos': {
      if (t.length > 200 || t.includes('?')) return null;
      if (/^(?:none|nothing|no)[.!]*$/i.test(t)) return { value: { field: pending, value: pending === 'preferences' ? ['no preference'] : [] }, hedged: false };
      const items = splitItems(t);
      return items.length ? { value: { field: pending, value: items }, hedged } : null;
    }
    default:
      return null;
  }
}

/**
 * Deterministic extraction of constraints from one message (no AI, no side effects). Works per sentence so
 * "I can do $200. Maybe Oct 17-19?" keeps the plain budget and flags the tentative dates. The caller decides what
 * a hedged value means for each field.
 */
export function extractConstraints(text: string, reference: string, pending?: ConstraintField): Extracted[] {
  const out: Extracted[] = [];
  const sentences = text.split(/(?<=[!?\n;])\s+|(?<=[a-z0-9)])\.\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) extractSentence(s, reference, pending, out);
  if (out.length === 0 && pending) {
    const a = pendingAnswer(text, reference, pending);
    if (a) out.push(a);
  }
  // One value per field per message: keep the first.
  const seen = new Set<string>();
  return out.filter((e) => !seen.has(e.value.field) && !!seen.add(e.value.field));
}
