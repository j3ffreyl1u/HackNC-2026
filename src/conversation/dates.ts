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
