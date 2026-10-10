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
