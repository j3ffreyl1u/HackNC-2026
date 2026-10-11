import { isValidIsoDate } from './money.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Deterministic due-date parsing, no AI. Accepts 2026-10-15, "Oct 15", "October 15th",
 * "15 Oct", "10/15" and "10/15/2026". `reference` (the message time) supplies a missing year;
 * a date more than 60 days in the past rolls to next year. Returns YYYY-MM-DD or null.
 */
export function parseDueDate(input: string, reference: string): string | null {
  const s = input.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (isValidIsoDate(s)) return s;
  const ref = new Date(reference);
  if (Number.isNaN(ref.getTime())) return null;

  let month: number | undefined;
  let day: number | undefined;
  let year: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = /^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(s))) {
    month = monthIndex(m[1]!); day = Number(m[2]); year = m[3] ? Number(m[3]) : undefined;
  } else if ((m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.?(?: (\d{4}))?$/.exec(s))) {
    month = monthIndex(m[2]!); day = Number(m[1]); year = m[3] ? Number(m[3]) : undefined;
  } else if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(s))) {
    month = Number(m[1]) - 1; day = Number(m[2]); year = m[3] ? Number(m[3]) : undefined;
  }
  if (month === undefined || month < 0 || month > 11 || day === undefined) return null;

  const build = (y: number) => `${y}-${String(month! + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  let y = year ?? ref.getUTCFullYear();
  let out = build(y);
  if (!isValidIsoDate(out)) return null;
  if (year === undefined) {
    const ageDays = (ref.getTime() - new Date(`${out}T00:00:00Z`).getTime()) / 86_400_000;
    if (ageDays > 60) {
      y += 1;
      out = build(y);
      if (!isValidIsoDate(out)) return null;
    }
  }
  return out;
}

function monthIndex(word: string): number | undefined {
  const i = MONTHS.indexOf(word.slice(0, 3));
  if (i < 0) return undefined;
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'][i]!;
  return full.startsWith(word) || word === 'sept' ? i : undefined;
}

const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const SEP = '(?:to|-|–|—|through|thru|until|till)';
const ISO_RANGE = new RegExp(`(\\d{4}-\\d{2}-\\d{2})(?:\\s*${SEP}\\s*(\\d{4}-\\d{2}-\\d{2}))?`, 'gi');
const MD_RANGE = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*${SEP}\\s*(?:the\\s+)?(?:${MONTH}\\.?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?)?\\b`, 'gi');
const SLASH_RANGE = new RegExp(`\\b(\\d{1,2})/(\\d{1,2})(?:\\s*${SEP}\\s*(?:(\\d{1,2})/)?(\\d{1,2}))?\\b`, 'gi');
// "14-16 Nov", "14th Nov", "14 to 16 November": day first. "may" is left out because "20 may" is far more often a verb.
const DAY_FIRST_MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DM_RANGE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*${SEP}\\s*(\\d{1,2})(?:st|nd|rd|th)?)?\\s+(?:of\\s+)?${DAY_FIRST_MONTH}\\b`, 'gi');
// "Nov 14 and 15", "Nov 14, 15 and 16": several days of one month, said as a list.
const MD_LIST = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?((?:\\s*(?:,|and|&)\\s*\\d{1,2}(?:st|nd|rd|th)?(?!\\d|\\s*(?:/|:|nights?|people|hours?|hrs?|bucks|dollars|%|\\$|am|pm)\\b))+)`, 'gi');
const WEEKDAY = /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b\.?,?/gi;

export interface ParsedWindow { start: string; end: string }

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Deterministic date-window parsing for trip availability, no AI. Finds ISO ranges (2026-10-17 to 2026-10-19),
 * "Oct 17-19", "Oct 30 - Nov 2", "October 17th through 19th", "10/17-10/19", and single days. A missing year
 * is the reference year, or the next year if that date has already passed. Impossible or reversed
 * ranges are dropped. Returns de-duplicated windows sorted by start (at most 6).
 */
export function parseDateWindows(input: string, reference: string): ParsedWindow[] {
  const ref = new Date(reference);
  if (Number.isNaN(ref.getTime())) return [];
  const today = ref.toISOString().slice(0, 10);   // the caller passes a reference whose UTC date is the trip's local date (see localReference)
  const refYear = ref.getUTCFullYear();
  const out: ParsedWindow[] = [];

  const resolve = (sm: number, sd: number, em: number | undefined, ed: number | undefined) => {
    if (sm < 1 || sm > 12) return;
    let y = refYear;
    let start = iso(y, sm, sd);
    if (!isValidIsoDate(start)) return;
    if (start < today) { y += 1; start = iso(y, sm, sd); if (!isValidIsoDate(start)) return; }
    let end = start;
    if (em !== undefined && ed !== undefined) {
      if (em < 1 || em > 12) return;
      end = iso(y, em, ed);
      if (isValidIsoDate(end) && end < start) end = iso(y + 1, em, ed);
      if (!isValidIsoDate(end)) return;
    }
    out.push({ start, end });
  };

  let rest = input.replace(WEEKDAY, ' ');   // "Fri Nov 14 - Sun Nov 16" is Nov 14 - Nov 16
  rest = rest.replace(ISO_RANGE, (_m, a: string, b?: string) => {
    const end = b ?? a;
    if (isValidIsoDate(a) && isValidIsoDate(end) && end >= a) out.push({ start: a, end });
    return ' ';
  });
  rest = rest.replace(MD_LIST, (_m, mo: string, d: string, more: string) => {
    const sm = monthIndex(mo.toLowerCase());
    if (sm === undefined) return ' ';
    const days = [Number(d), ...[...more.matchAll(/\d{1,2}/g)].map((x) => Number(x[0]))].sort((a, b) => a - b);
    let runStart = days[0]!; let prev = days[0]!;
    for (const day of [...days.slice(1), Infinity]) {
      if (day === prev + 1) { prev = day; continue; }
      resolve(sm + 1, runStart, sm + 1, prev);
      runStart = day; prev = day;
    }
    return ' ';
  });
  rest = rest.replace(DM_RANGE, (_m, d: string, d2: string | undefined, mo: string) => {
    const sm = monthIndex(mo.toLowerCase());
    if (sm === undefined) return ' ';
    resolve(sm + 1, Number(d), d2 === undefined ? undefined : sm + 1, d2 === undefined ? undefined : Number(d2));
    return ' ';
  });
  rest = rest.replace(MD_RANGE, (_m, mo: string, d: string, mo2?: string, d2?: string) => {
    const sm = monthIndex(mo.toLowerCase());
    if (sm === undefined) return ' ';
    const em = d2 === undefined ? undefined : mo2 ? monthIndex(mo2.toLowerCase()) : sm;
    if (d2 !== undefined && em === undefined) return ' ';
    resolve(sm + 1, Number(d), em === undefined ? undefined : em + 1, d2 === undefined ? undefined : Number(d2));
    return ' ';
  });
  rest.replace(SLASH_RANGE, (_m, m1: string, d1: string, m2?: string, d2?: string) => {
    const endMonth = d2 === undefined ? undefined : m2 === undefined ? Number(m1) : Number(m2);   // "11/14-16" stays in November
    resolve(Number(m1), Number(d1), endMonth, d2 === undefined ? undefined : Number(d2));
    return ' ';
  });

  // "this weekend" / "next weekend": Friday to Sunday. Without this a plain phrase goes to the language model, which can take half a minute to work it out.
  const weekend = /\b(this|next)\s+weekend\b/i.exec(input);
  if (weekend) {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const base = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
    const dow = ref.getUTCDay();   // 0 Sunday .. 6 Saturday
    const toFriday = dow === 6 ? -1 : dow === 0 ? -2 : 5 - dow;
    const thisFriday = base + toFriday * 86_400_000;
    const start = weekend[1]!.toLowerCase() === 'this' ? Math.max(thisFriday, base) : thisFriday + 7 * 86_400_000;
    out.push({ start: day(start), end: day(thisFriday + (weekend[1]!.toLowerCase() === 'this' ? 0 : 7 * 86_400_000) + 2 * 86_400_000) });
  }

  // "the weekend of Nov 21": the Friday to Sunday that holds that day, not just the one day.
  if (/\bweekend\s+(?:of|around|starting|beginning)\b/i.test(input)) {
    const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    for (const w of out) {
      if (w.start !== w.end) continue;
      const dow = new Date(`${w.start}T00:00:00Z`).getUTCDay();
      const friday = shift(w.start, dow === 6 ? -1 : dow === 0 ? -2 : 5 - dow);
      w.start = friday; w.end = shift(friday, 2);
    }
  }

  const seen = new Set<string>();
  return out
    .filter((w) => !seen.has(w.start + w.end) && !!seen.add(w.start + w.end))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 6);
}

/** Throws a clear error for an unknown IANA timezone (so a bad config fails at startup, not mid-chat). */
export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`Invalid trip timezone: ${timeZone}`);
  }
}

/** The UTC instant (ISO) at which `date` (YYYY-MM-DD) begins in `timeZone`. DST-safe. */
export function localMidnight(date: string, timeZone: string): string {
  const target = Date.parse(`${date}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
    instant += target - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  }
  return new Date(instant).toISOString();
}

export interface IntervalWindow { startAt: string; endAt: string; timeZone: string }

/**
 * Inclusive date windows -> real intervals: local midnight of the start date to local midnight of the day
 * AFTER the end date, in the trip timezone. We never invent hours from casual texting.
 */
export function toIntervalWindows(windows: ParsedWindow[], timeZone: string): IntervalWindow[] {
  return windows.map((w) => ({
    startAt: localMidnight(w.start, timeZone),
    endAt: localMidnight(new Date(Date.parse(`${w.end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), timeZone),
    timeZone,
  }));
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov 14-16", "Nov 30 - Dec 2", "Nov 14" from inclusive YYYY-MM-DD dates, for friendly replies. */
export function formatWindow(w: ParsedWindow): string {
  const [, sm, sd] = w.start.split('-').map(Number) as [number, number, number];
  const [, em, ed] = w.end.split('-').map(Number) as [number, number, number];
  if (w.start === w.end) return `${MON[sm - 1]} ${sd}`;
  return sm === em ? `${MON[sm - 1]} ${sd}-${ed}` : `${MON[sm - 1]} ${sd} - ${MON[em - 1]} ${ed}`;
}

/**
 * An instant whose UTC date is the date it currently is in the trip's timezone, so "free Oct 11" typed at
 * 9:30pm Eastern on Oct 11 means today, not a year from now. Only the date matters to the date parser.
 */
export function localReference(occurredAt: string, timeZone: string): string {
  const at = new Date(occurredAt);
  if (Number.isNaN(at.getTime())) return occurredAt;
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T12:00:00.000Z`;
  } catch {
    return occurredAt;
  }
}
