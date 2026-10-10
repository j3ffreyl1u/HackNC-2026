/**
 * Availability. Calendars give BUSY time only. A gap in someone's calendar is evidence, never proof
 * they are willing to travel: `suggestFreeWindows` output must be shown to the member to confirm, and
 * only their confirmed windows become `availability` constraints. Manual windows always work.
 */
import type { DateWindow } from '../conversation/contracts-local.js';

export interface BusyInterval {
  /** ISO timestamps with timezone/offset. */
  start: string;
  end: string;
}

export class AvailabilityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvailabilityUnavailableError';
  }
}

export interface AvailabilityProvider {
  /** Busy intervals overlapping [from, to). Throws AvailabilityUnavailableError if the source cannot answer. */
  getBusyIntervals(memberId: string, from: string, to: string): Promise<BusyInterval[]>;
}

/** Manual provider: members (or tests) declare busy time by hand. No data means "unknown", not "free". */
export interface ManualAvailabilityProvider extends AvailabilityProvider {
  setBusy(memberId: string, intervals: BusyInterval[]): void;
  has(memberId: string): boolean;
}

export function createManualAvailabilityProvider(): ManualAvailabilityProvider {
  const store = new Map<string, BusyInterval[]>();
  return {
    setBusy: (memberId, intervals) => void store.set(memberId, intervals.map((i) => ({ ...i }))),
    has: (memberId) => store.has(memberId),
    async getBusyIntervals(memberId, from, to) {
      const f = Date.parse(from);
      const t = Date.parse(to);
      return (store.get(memberId) ?? []).filter((i) => Date.parse(i.start) < t && Date.parse(i.end) > f);
    },
  };
}

const DAY_MS = 86_400_000;

function localDate(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Whole calendar days (in `timezone`) between `fromDate` and `toDate` inclusive with no busy time,
 * merged into runs of at least `minDays`. SUGGESTIONS ONLY, see the module comment.
 */
export function suggestFreeWindows(
  busy: BusyInterval[],
  fromDate: string,
  toDate: string,
  timezone: string,
  minDays = 1,
): DateWindow[] {
  const blocked = new Set<string>();
  for (const b of busy) {
    const s = Date.parse(b.start);
    const e = Date.parse(b.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    const last = localDate(e - 1, timezone); // end is exclusive
    for (let d = localDate(s, timezone); d <= last; d = addDays(d, 1)) blocked.add(d);
  }
  const out: DateWindow[] = [];
  let runStart: string | null = null;
  let prev: string | null = null;
  const flush = () => {
    if (runStart && prev && (Date.parse(prev) - Date.parse(runStart)) / DAY_MS + 1 >= minDays) out.push({ start: runStart, end: prev });
    runStart = null;
  };
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    if (blocked.has(d)) flush();
    else {
      runStart ??= d;
      prev = d;
    }
  }
  flush();
  return out;
}

export { createGoogleFreeBusyProvider } from './google.js';
export type { GoogleFreeBusyOptions } from './google.js';
