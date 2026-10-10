import { describe, expect, it } from 'vitest';
import { DAY_END_HOUR, DAY_START_HOUR, assertTimeZone, atLocalHour, localHour, scheduleStops } from '../../src/planning/schedule.js';
import type { ResearchStop } from '../../src/research/types.js';

const NY = 'America/New_York';
const stop = (label: string, hours: number, travel?: number): ResearchStop => ({
  label, location: 'Somewhere, NC', tags: ['Hiking'], hours, evidenceIds: ['e1'], ...(travel !== undefined ? { travelMinutesFromPrevious: travel } : {}),
});
const ms = (iso: string) => Date.parse(iso);
const local = (iso: string, tz = NY) => localHour(ms(iso), tz);

describe('time zone helpers', () => {
  it('reads local clock time, including daylight saving', () => {
    expect(localHour(ms('2026-10-16T17:00:00Z'), NY)).toBe(13); // EDT, UTC-4
    expect(localHour(ms('2026-11-02T17:00:00Z'), NY)).toBe(12); // EST, UTC-5
    expect(localHour(ms('2026-10-16T17:30:00Z'), 'Asia/Kolkata')).toBe(23); // UTC+5:30
  });

  it('finds a local hour on the same or a later day', () => {
    expect(new Date(atLocalHour(ms('2026-10-16T17:00:00Z'), NY, 9)).toISOString()).toBe('2026-10-16T13:00:00.000Z');
    expect(new Date(atLocalHour(ms('2026-10-16T17:00:00Z'), NY, 9, 1)).toISOString()).toBe('2026-10-17T13:00:00.000Z');
  });

  it('uses the right offset across the end of daylight saving (2026-11-01)', () => {
    // 9am the next morning is EST (UTC-5), not EDT, even though "now" is still EDT.
    expect(new Date(atLocalHour(ms('2026-10-31T15:00:00Z'), NY, 9, 1)).toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(new Date(atLocalHour(ms('2026-11-01T15:00:00Z'), NY, 20)).toISOString()).toBe('2026-11-02T01:00:00.000Z');
  });

  it('rejects a time zone Intl does not know', () => {
    expect(() => assertTimeZone('Mars/Olympus')).toThrow(RangeError);
    expect(() => assertTimeZone(NY)).not.toThrow();
  });
});

describe('scheduleStops', () => {
  // Friday 1pm EDT to Sunday 1pm EDT.
  const start = ms('2026-10-16T17:00:00Z');
  const end = ms('2026-10-18T17:00:00Z');

  it('puts stops after the drive on the same afternoon when they fit', () => {
    const { itinerary } = scheduleStops([stop('Drive', 2.5, 150), stop('Walk', 1, 10)], 'c', start, end);
    expect(itinerary.map((i) => [i.label, i.startAt, i.endAt])).toEqual([
      ['Drive', '2026-10-16T19:30:00.000Z', '2026-10-16T22:00:00.000Z'], // 3:30 to 6:00 pm EDT
      ['Walk', '2026-10-16T22:10:00.000Z', '2026-10-16T23:10:00.000Z'], // 6:10 to 7:10 pm EDT
    ]);
  });

  it('moves a stop that would not finish by 8 pm to the next morning, even by a minute', () => {
    // 6:00 pm + 10 minutes + 1 h 51 min = 8:01 pm
    const { itinerary } = scheduleStops([stop('Drive', 2.5, 150), stop('Late', 1 + 51 / 60, 10)], 'c', start, end);
    expect(local(itinerary[1].startAt)).toBe(DAY_START_HOUR);
    expect(itinerary[1].startAt.slice(0, 10)).toBe('2026-10-17');
  });

  it('moves a stop that would run past the evening to the next morning', () => {
    const { itinerary } = scheduleStops([stop('Drive', 2.5, 150), stop('Day hike', 5, 20)], 'c', start, end);
    const [drive, hike] = itinerary;
    expect(local(drive.endAt)).toBe(18);
    expect(local(hike.startAt)).toBe(DAY_START_HOUR);
    expect(hike.startAt.slice(0, 10)).toBe('2026-10-17'); // Saturday morning
    expect(local(hike.endAt)).toBe(14);
  });

  it('never schedules before the morning start or past the evening cutoff', () => {
    const stops = [stop('A', 2, 150), stop('B', 4, 20), stop('C', 5, 20), stop('D', 3, 25), stop('E', 2, 15)];
    const { itinerary } = scheduleStops(stops, 'c', start, end);
    expect(itinerary.length).toBeGreaterThan(2);
    for (const item of itinerary) {
      expect(local(item.startAt)).toBeGreaterThanOrEqual(DAY_START_HOUR);
      expect(local(item.endAt)).toBeLessThanOrEqual(DAY_END_HOUR);
      expect(local(item.startAt) < local(item.endAt)).toBe(true);
    }
  });

  it('keeps stops in order without overlap, and uses the second day', () => {
    const { itinerary } = scheduleStops([stop('A', 2, 150), stop('B', 5, 20), stop('C', 4, 15)], 'c', start, end);
    for (let i = 1; i < itinerary.length; i += 1) expect(itinerary[i].startAt >= itinerary[i - 1].endAt).toBe(true);
    expect(new Set(itinerary.map((i) => i.startAt.slice(0, 10))).size).toBeGreaterThan(1);
  });

  it('leaves out a stop too long for a day and says why', () => {
    const { itinerary, leftOut } = scheduleStops([stop('Marathon', 12), stop('Walk', 1)], 'c', start, end);
    expect(itinerary.map((i) => i.label)).toEqual(['Walk']);
    expect(leftOut).toEqual([{ label: 'Marathon', reason: expect.stringMatching(/longer than a day/) }]);
  });

  it('leaves out a stop that cannot finish before the trip ends', () => {
    const { itinerary, leftOut } = scheduleStops([stop('A', 8, 0), stop('B', 8, 0), stop('C', 8, 0), stop('D', 8, 0)], 'c', start, end);
    expect(leftOut.length).toBeGreaterThan(0);
    expect(leftOut[0].reason).toMatch(/not enough time/);
    for (const item of itinerary) expect(ms(item.endAt)).toBeLessThanOrEqual(end);
  });

  it('carries ids, evidence, lowercase tags and travel time through', () => {
    const [item] = scheduleStops([stop('Hike', 2, 30)], 'trip-r1-x', start, end).itinerary;
    expect(item).toMatchObject({ itemId: 'trip-r1-x-1', label: 'Hike', evidenceIds: ['e1'], tags: ['hiking'], travelMinutesFromPrevious: 30 });
  });

  it('gives the same hours on either side of a daylight-saving change', () => {
    // Trip over the weekend clocks go back: local times still land between 9 and 20.
    const s = ms('2026-10-31T16:00:00Z'); // Saturday noon EDT
    const e = ms('2026-11-02T17:00:00Z');
    const { itinerary } = scheduleStops([stop('A', 5), stop('B', 8), stop('C', 6)], 'c', s, e);
    for (const item of itinerary) {
      expect(local(item.startAt)).toBeGreaterThanOrEqual(DAY_START_HOUR);
      expect(local(item.endAt)).toBeLessThanOrEqual(DAY_END_HOUR);
    }
  });

  it('works in another time zone', () => {
    const la = 'America/Los_Angeles';
    const { itinerary } = scheduleStops([stop('A', 3, 60), stop('B', 8)], 'c', ms('2026-10-16T20:00:00Z'), ms('2026-10-18T20:00:00Z'), la);
    for (const item of itinerary) {
      expect(local(item.startAt, la)).toBeGreaterThanOrEqual(DAY_START_HOUR);
      expect(local(item.endAt, la)).toBeLessThanOrEqual(DAY_END_HOUR);
    }
  });
});
