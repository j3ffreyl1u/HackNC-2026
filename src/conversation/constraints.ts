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
const BUDGET_KEYWORD = '(?:budget|max(?:imum)?|cap|limit|spend|afford|up to|at most|no more than|(?:can|could|may|might|able to) (?:only )?(?:do|pay|swing|spend|afford)|can swing|able to (?:do|pay|spend|afford)|only (?:got|have|has)|all[- ]in)';
const BUDGET_AFTER = new RegExp(`\\b${BUDGET_KEYWORD}\\b[^.!?\\n$\\d]{0,30}?(?:${MONEY})`, 'i');
const BUDGET_BEFORE = new RegExp(`(?:${MONEY})\\s*(?:(?:is|'s)\\s+(?:my|the|our)\\s+(?:(?:firm|hard|absolute|final)\\s+)?)?(?:max|maximum|total|tops|cap|limit|all[- ]in|budget|at most)\\b`, 'i');
const BUDGET_BARE = /\b(?:budget|max(?:imum)?|cap|limit)\b\s*(?:is|of|:|=|around|about)?\s*([\d,]+(?:\.\d{1,2})?)\b(?!\s*[a-z])/i;
const BARE_AMOUNT = /^\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)?[.!]*$/i;
const AVAIL_WORDS = /\b(free|available|availability|open|works?|can (?:do|go|make(?: it)?|leave)|good|window|off|maybe|perhaps|how about|what about|could (?:do|go|make it))\b/i;
const NEGATIVE = /\b(not|n't|busy|can'?t|cannot|unavailable|booked|out of town)\b/i;

/** One-way drive limit in minutes from text like "within 3 hours", "1.5 hour drive", "within 90 minutes". */
export function parseMaxTravelMinutes(text: string): number | undefined {
  let m: RegExpExecArray | null;
  let minutes: number | undefined;
  if ((m = /\b(\d{1,2}(?:\.\d)?)\s*[- ]?(?:hours?|hrs?|h)\b/i.exec(text))) minutes = Math.round(Number(m[1]) * 60);
  else if ((m = /\b(\d{2,3})\s*[- ]?(?:minutes?|mins?)\b/i.exec(text))) minutes = Number(m[1]);
  return minutes !== undefined && minutes >= 15 && minutes <= 1440 ? minutes : undefined;
}

const NOT_A_PLACE = /\b(i|we|you|he|she|they|has|have|had|is|are|was|am|can|will|would|want|like|need|car|trip|my|our|it|not|but|with|for|please|thanks|yes|no)\b/i;
const THIRD_PERSON_VEHICLE = /\b(?:[Ww]e|[Ss]omeone|[Ss]omebody|[Aa]nyone|[Ee]veryone|[A-Z][a-z]+)\s+(?:has|have|got)\s+(?:a\s+|an\s+|the\s+|two\s+|2\s+|both\s+)?(?:cars?|vehicles?|trucks?|suvs?)\b/;

const NOT_ORIGIN = /^(?:there|here|home|it|that|this|them|where|somewhere|anywhere)$/i;
/** A sentence that is a question ("how long is the drive to Asheville") is not a statement of where we are going. */
const QUESTION_START = /^(?:how|what|what's|whats|where|when|which|who|why|is|are|does|do|can|could|will|would|should)\b/i;

const clean = (s: string) => s.trim().replace(/^(?:(?:a bunch of|a lot of|lots of|a few|some|a|an|the)\s+)+/i, '').replace(/[.!,;]+$/, '').trim();
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

/** A trailing request or question clause (", can you show us some options?") says nothing about how sure the earlier facts are. */
const TRAILING_REQUEST = /[,;]\s*(?:and\s+|so\s+)?(?:(?:can|could|would|will)\s+you|please|pls|what|how|where|when)\b[^,;]*$/i;

function extractSentence(s: string, reference: string, pending: ConstraintField | undefined, out: Extracted[]): void {
  const hedged = HEDGE.test(s.replace(TRAILING_REQUEST, ''));
  const push = (value: ConstraintValue, extra: Partial<Extracted> = {}) => out.push({ value, hedged, ...extra });
  let m: RegExpExecArray | null;

  const cents = budgetFrom(s);
  if (cents !== null) push({ field: 'budget', value: cents });

  const windows = parseDateWindows(s, reference);
  if (windows.length && (AVAIL_WORDS.test(s) || pending === 'availability' || NEGATIVE.test(s))) {
    if (NEGATIVE.test(s) && !/\b(free|available)\b/i.test(s.replace(/\b(not|n't) (free|available)/gi, ''))) push({ field: 'availability', value: windows }, { negative: true });
    else push({ field: 'availability', value: windows });
  }

  if ((m = /\b(\d{1,2}|one|two|three|four|five|six|seven)\s*[- ]?nights?\b/i.exec(s))) {
    const n = /^\d/.test(m[1]!) ? Number(m[1]) : ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'].indexOf(m[1]!.toLowerCase());
    if (n >= 1 && n <= 30) push({ field: 'duration', value: n });
  }
  else if (!s.includes('?') && /\blong weekend\b/i.test(s)) push({ field: 'duration', value: 3 });
  else if (!s.includes('?') && /\b(?:a|quick|short|just a|over a)\s+weekend(?!\s+of\b)|\bweekend\s+(?:trip|getaway)\b/i.test(s) && !windows.length) push({ field: 'duration', value: 2 });
  if ((m = /\b(?:leav(?:e|ing)|depart(?:ing)?|start(?:ing)?|driv(?:e|ing)|coming|going)\s+from\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=[,.;!?]|\s+(?:and|but|on|at|around|with|to|for|in|if)\b|$)/i.exec(s)) ?? (m = /\b(?:origin|departing city)\s*(?:is|:)\s*([A-Za-z][A-Za-z .'-]{1,40})/i.exec(s))) {
    const place = m![1]!.trim();
    if (!NOT_ORIGIN.test(place)) push({ field: 'origin', value: place });
  }
  if ((m = /\b(?:within|no more than|at most|up to|under|max(?:imum)? of)\s+(?:about\s+|around\s+)?(\d{1,2}(?:\.\d)?)\s*(?:hours?|hrs?|h)\b(?!\s*of\s+(?:sleep|work))/i.exec(s)) ?? (m = /\b(\d{1,2}(?:\.\d)?)\s*[- ]?(?:hours?|hrs?)\s+(?:drive|away|radius)\b/i.exec(s))) {
    push({ field: 'region', value: `within ${m![1]} hours by car`, maxTravelMinutes: Math.round(Number(m![1]) * 60) });
  } else if ((m = /\b(?:[Gg]o|[Tt]ravel|[Dd]rive|[Hh]ead|going|headed|heading|trip)\s+to\s+(?:the\s+)?((?:[A-Z][A-Za-z.'-]*)(?:\s+[A-Z][A-Za-z.'-]*){0,3})/.exec(s)) && !QUESTION_START.test(s)) {
    push({ field: 'region', value: clean(m[1]!) });
  } else if (/\b(?:any|whatever)\s+distance\b|\bdrive\s+(?:anywhere|as far as)\b|\bdon'?t\s+mind\s+(?:driving|how far)\b/i.test(s)) {
    push({ field: 'region', value: 'any distance by car', maxTravelMinutes: 1440 });
  } else if ((m = /\b(?:destination|region|area)\s*(?:is|:)\s*([A-Za-z][A-Za-z ,.'-]{1,40})/i.exec(s))) {
    const value = clean(m[1]!);
    const maxTravelMinutes = parseMaxTravelMinutes(value);
    push({ field: 'region', value, ...(maxTravelMinutes !== undefined ? { maxTravelMinutes } : {}) });
  }
  if (/\bi(?:'ve|\s+have|\s+got)\s+(?:got\s+)?(?:a\s+|my\s+)?(?:own\s+)?(?:car|vehicle|truck|suv)\b|\bi\s+can\s+drive\b|\bi(?:'ll| will)\s+drive\b|\b(?:we|i)(?:'ll| will| can| could)?\s+(?:take|use|bring|drive)\s+(?:my|our|the)\s+(?:own\s+)?(?:car|truck|suv|van|vehicle)\b/i.test(s)) push({ field: 'transport', value: 'own_vehicle', vehicleAvailable: true });
  else if (pending === 'transport' && !s.includes('?') && /\b(?:has|have|got|owns?|can (?:drive|bring))\s+(?:one|it|a ride|a vehicle|a car|a truck|an suv)\b|\b(?:do|does)\b|\bmy (?:car|truck)\b/i.test(s) && !/\b(?:no|nobody|none|don'?t|doesn'?t|not)\b/i.test(s)) push({ field: 'transport', value: 'own_vehicle', vehicleAvailable: true });
  else if (pending === 'transport' && !s.includes('?') && /\b(?:nobody|no ?one|none of us|neither of us|no)\b|\b(?:don'?t|doesn'?t|do not|does not)\s+(?:have|got|own)\b/i.test(s)) push({ field: 'transport', value: 'no_vehicle', vehicleAvailable: false });
  else if (!s.includes('?') && THIRD_PERSON_VEHICLE.test(s)) push({ field: 'transport', value: 'own_vehicle', vehicleAvailable: true });
  else if (/\bi\s+(?:don'?t|do not)\s+have\s+(?:a\s+)?(?:car|vehicle)\b|\bno car\b|\bi\s+(?:can'?t|cannot)\s+drive\b/i.test(s)) push({ field: 'transport', value: 'no_vehicle', vehicleAvailable: false });

  if (/\b(?:no (?:real )?preferences?|don'?t (?:really )?care|i'?m (?:easy|flexible|open to anything))\b/i.test(s)) {
    push({ field: 'preferences', value: ['no preference'] });
  } else if ((m = /\b(?:i|we)(?:\s+really)?(?:\s+|(?='))(?:prefer|like|love|enjoy|(?:am|are|'m|'re)\s+into|(?:want|'d like|would like) to (?:be able to )?(?:do|try|see|visit|explore|check out))\s+(.+)$/i.exec(s))) {
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
    case 'region': {
      // Only something that looks like a place: a few words, no pronouns/verbs ("Mason has a car for the trip" is not a destination).
      const place = t.replace(/[.!]+$/, '');
      const looksLikePlace = /^[A-Za-z][A-Za-z ,.'-]{1,40}$/.test(place) && place.split(/\s+/).length <= 4 && !NOT_A_PLACE.test(place);
      return looksLikePlace && !hedged ? { value: { field: pending, value: place }, hedged } : null;
    }
    case 'preferences':
    case 'must_dos': {
      if (t.length > 200 || t.includes('?')) return null;
      if (/^(?:none|nothing|no)[.!]*$/i.test(t)) return { value: { field: pending, value: pending === 'preferences' ? ['no preference'] : [] }, hedged: false };
      // "I want to have fun and learn about historical museums" is about historical museums, not the whole sentence.
      let core = t.replace(/^(?:i|we)(?:\s+really)?\s+(?:want to|wanna|would like to|'d like to|like to|like|love|enjoy|prefer|am into|are into|'m into|'re into)\s+/i, '');
      for (let i = 0; i < 3; i += 1) core = core.replace(/^(?:have fun(?:\s+and)?|have a good time(?:\s+and)?|just\s+|learn(?:ing)?(?:\s+about)?|see|visit|do|try|explore|check out|go to|going to)\s+/i, '');
      const items = splitItems(core.trim() === '' ? t : core);
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
  return extractWithCoverage(text, reference, pending).items;
}

/** Small talk that needs no interpretation (and therefore no model call). */
export const TRIVIAL = /^(?:(?:hi|hey|hello|yo|thanks?|thank you|thx|ty|so much|very much|a lot|a ton|appreciate (?:it|that)|you(?:'re| are) (?:the best|awesome|great|amazing)|the best|ok(?:ay)?|cool|nice|great|awesome|perfect|sweet|lol|haha+|lmao|got it|sounds good|no worries|np|please|pls|sorry|oops)\b[\s,.!?:)-]*)+$/i;

export interface Coverage {
  items: Extracted[];
  /** Sentences the rules did not recognize at all (minus small talk). These are what gets handed to the model. */
  unmatched: string[];
}

/**
 * Like extractConstraints, but also reports which sentences the rules did NOT understand, so the caller can hand
 * exactly those to the language model instead of dropping them or guessing.
 */
export function extractWithCoverage(text: string, reference: string, pending?: ConstraintField): Coverage {
  const out: Extracted[] = [];
  const unmatched: string[] = [];
  const sentences = text.split(/(?<=[!?\n;])\s+|(?<=[a-z0-9)])\.\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const before = out.length;
    extractSentence(s, reference, pending, out);
    if (out.length === before) {
      if (!TRIVIAL.test(s) && s.replace(/[^A-Za-z0-9]/g, '').length >= 3) unmatched.push(s);
      continue;
    }
    // Understood overall, but a long extra clause ("... and honestly anywhere with a good brewery works") may not be.
    for (const clause of s.split(/,|;|\band\b|\bbut\b|\balso\b|\bplus\b/i).map((c) => c.trim())) {
      if (clause.split(/\s+/).length < 4 || TRIVIAL.test(clause)) continue;
      const probe: Extracted[] = [];
      extractSentence(clause, reference, pending, probe);
      if (probe.length === 0) unmatched.push(clause);
    }
  }
  if (out.length === 0 && pending) {
    const a = pendingAnswer(text, reference, pending);
    if (a) { out.push(a); unmatched.length = 0; }
  }
  // A destination and a drive limit in separate sentences describe the same region: keep both.
  const regions = out.filter((e) => e.value.field === 'region');
  if (regions.length > 1) {
    const [first, ...rest] = regions as Array<Extracted & { value: { field: 'region'; value: string; maxTravelMinutes?: number } }>;
    const limit = rest.map((r) => r.value.maxTravelMinutes).find((n) => n !== undefined);
    if (first!.value.maxTravelMinutes === undefined && limit !== undefined) first!.value.maxTravelMinutes = limit;
  }
  // One value per field per message: keep the first.
  const seen = new Set<string>();
  return { items: out.filter((e) => !seen.has(e.value.field) && !!seen.add(e.value.field)), unmatched };
}
