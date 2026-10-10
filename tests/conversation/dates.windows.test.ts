import { describe, expect, it } from 'vitest';
import { parseDateWindows } from '../../src/conversation/dates.js';

const ref = '2026-10-01T12:00:00Z';
describe('parseDateWindows', () => {
  it('parses month ranges, cross-month ranges, ordinals and singles', () => {
    expect(parseDateWindows('Oct 17-19', ref)).toEqual([{ start: '2026-10-17', end: '2026-10-19' }]);
    expect(parseDateWindows('October 17th through 19th', ref)).toEqual([{ start: '2026-10-17', end: '2026-10-19' }]);
    expect(parseDateWindows('Oct 30 - Nov 2', ref)).toEqual([{ start: '2026-10-30', end: '2026-11-02' }]);
    expect(parseDateWindows('Nov 7', ref)).toEqual([{ start: '2026-11-07', end: '2026-11-07' }]);
  });
  it('parses ISO and slash forms and several windows in one message', () => {
    expect(parseDateWindows('2026-10-24 to 2026-10-26', ref)).toEqual([{ start: '2026-10-24', end: '2026-10-26' }]);
    expect(parseDateWindows('10/17-10/19 or Oct 24-26', ref)).toEqual([
      { start: '2026-10-17', end: '2026-10-19' },
      { start: '2026-10-24', end: '2026-10-26' },
    ]);
  });
  it('rolls past dates to next year and handles year-end ranges', () => {
    expect(parseDateWindows('Sep 5', ref)).toEqual([{ start: '2027-09-05', end: '2027-09-05' }]);
    expect(parseDateWindows('Dec 28 - Jan 3', ref)).toEqual([{ start: '2026-12-28', end: '2027-01-03' }]);
  });
  it('drops impossible dates and returns nothing for prose', () => {
    expect(parseDateWindows('Feb 30', ref)).toEqual([]);
    expect(parseDateWindows('hiking and a town visit', ref)).toEqual([]);
    expect(parseDateWindows('may I ask something', ref)).toEqual([]);
  });
});

import { assertTimeZone, localMidnight, toIntervalWindows } from '../../src/conversation/dates.js';

describe('interval conversion (trip timezone)', () => {
  const tz = 'America/New_York';
  it('local midnight of the start day to local midnight of the day after the end day', () => {
    expect(toIntervalWindows([{ start: '2026-10-24', end: '2026-10-26' }], tz)).toEqual([
      { startAt: '2026-10-24T04:00:00.000Z', endAt: '2026-10-27T04:00:00.000Z', timeZone: tz },
    ]);
  });
  it('is DST-safe: the window across the Nov 1 fall-back is 49 real hours', () => {
    const [w] = toIntervalWindows([{ start: '2026-10-31', end: '2026-11-01' }], tz);
    expect(w).toMatchObject({ startAt: '2026-10-31T04:00:00.000Z', endAt: '2026-11-02T05:00:00.000Z' });
    expect((Date.parse(w!.endAt) - Date.parse(w!.startAt)) / 3_600_000).toBe(49);
  });
  it('uses the trip timezone, not the machine timezone', () => {
    expect(localMidnight('2026-10-24', 'America/Los_Angeles')).toBe('2026-10-24T07:00:00.000Z');
    expect(localMidnight('2026-10-24', 'UTC')).toBe('2026-10-24T00:00:00.000Z');
  });
  it('rejects an unknown timezone', () => {
    expect(() => assertTimeZone('Mars/Olympus')).toThrow(/Invalid trip timezone/);
  });
});
