import type { ItineraryItem } from './types.js';
import type { ResearchStop } from '../research/types.js';

// Lays research stops out on real days: nothing before the morning start or after the evening cutoff in the
// trip's local time, with the night spent between days. No dependencies: time zones go through `Intl`.

/** The local zone used when a trip does not carry one. The shared contracts have no timezone field yet. */
export const DEFAULT_TIME_ZONE = 'America/New_York';
/** Stops start no earlier than this local hour and finish no later than the cutoff. */
export const DAY_START_HOUR = 9;
export const DAY_END_HOUR = 20;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/** Throws `RangeError` for a name `Intl` does not know. */
export function assertTimeZone(timeZone: string): void {
  new Intl.DateTimeFormat('en-US', { timeZone });
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(ms: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** Local clock time as fractional hours, e.g. 13.5 for 1:30 pm. */
export function localHour(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return p.hour + p.minute / 60;
}

/** Offset of the zone from UTC at an instant, in ms (negative west of Greenwich). */
function offsetMs(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE;
}

/** The instant at `hour`:00 local on the local date of `ms`, shifted by `dayOffset` days. Handles DST changes. */
export function atLocalHour(ms: number, timeZone: string, hour: number, dayOffset = 0): number {
  const p = localParts(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day + dayOffset, hour);
  let guess = wall - offsetMs(wall, timeZone);
  guess = wall - offsetMs(guess, timeZone); // re-check the offset at the answer, in case a DST change fell between
  return guess;
}

export interface Scheduled {
  itinerary: ItineraryItem[];
  /** Labels of stops that could not be placed, with why. */
  leftOut: Array<{ label: string; reason: string }>;
}

/**
 * Place stops in order. Each stop begins after the previous one ends plus its travel time. If that would start
 * before the morning start it waits until then; if it would not finish by the evening cutoff it moves to the
 * next morning. A stop too long for one day, or that cannot finish before the trip ends, is left out.
 */
export function scheduleStops(
  stops: readonly ResearchStop[],
  idPrefix: string,
  startMs: number,
  endMs: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): Scheduled {
  const itinerary: ItineraryItem[] = [];
  const leftOut: Scheduled['leftOut'] = [];
  const maxHours = DAY_END_HOUR - DAY_START_HOUR;
  let cursor = startMs;

  stops.forEach((stop, index) => {
    if (stop.hours > maxHours) {
      leftOut.push({ label: stop.label, reason: `it takes longer than a day's ${maxHours} hours` });
      return;
    }
    let begin = cursor + (stop.travelMinutesFromPrevious ?? 0) * MS_PER_MINUTE;
    if (localHour(begin, timeZone) < DAY_START_HOUR) begin = atLocalHour(begin, timeZone, DAY_START_HOUR);
    if (begin + stop.hours * MS_PER_HOUR > atLocalHour(begin, timeZone, DAY_END_HOUR)) {
      begin = atLocalHour(begin, timeZone, DAY_START_HOUR, 1);
    }
    const finish = begin + stop.hours * MS_PER_HOUR;
    if (finish > endMs) {
      leftOut.push({ label: stop.label, reason: 'there is not enough time in these dates' });
      return;
    }
    itinerary.push({
      itemId: `${idPrefix}-${index + 1}`,
      label: stop.label,
      location: stop.location,
      startAt: new Date(begin).toISOString(),
      endAt: new Date(finish).toISOString(),
      ...(stop.travelMinutesFromPrevious !== undefined ? { travelMinutesFromPrevious: stop.travelMinutesFromPrevious } : {}),
      evidenceIds: [...stop.evidenceIds],
      tags: stop.tags.map((t) => t.toLowerCase()),
    });
    cursor = finish;
  });
  return { itinerary, leftOut };
}
