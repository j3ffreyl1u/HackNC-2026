import { describe, expect, it } from 'vitest';
import { planToIcs, type IcsPlan } from '../../src/planning/calendar.js';

const plan = (overrides: Partial<IcsPlan> = {}): IcsPlan => ({
  candidateId: 'cand-b',
  revision: 12,
  title: 'State park and small-town weekend',
  itinerary: [
    { itemId: 's1', label: 'Drive to the park', location: 'Hanging Rock area', startAt: '2026-11-14T08:00:00-05:00', endAt: '2026-11-14T10:30:00-05:00' },
    { itemId: 's2', label: 'Day hike', location: 'State park, NC', startAt: '2026-11-14T11:00:00-05:00', endAt: '2026-11-14T16:00:00-05:00' },
  ],
  ...overrides,
});
const NOW = '2026-10-11T05:00:00.000Z';
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '');

describe('planToIcs', () => {
  it('makes one event per stop in a valid calendar, with CRLF line endings', () => {
    const ics = planToIcs(plan(), { now: NOW })!;
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics.match(/END:VEVENT/g)).toHaveLength(2);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(ics).toMatch(/\r\n$/);
  });

  it('writes times in UTC converted from the stop\'s own offset', () => {
    const ics = unfold(planToIcs(plan(), { now: NOW })!);
    expect(ics).toContain('DTSTART:20261114T130000Z');
    expect(ics).toContain('DTEND:20261114T153000Z');
    expect(ics).toContain('DTSTAMP:20261011T050000Z');
  });

  it('escapes commas, semicolons, backslashes and newlines in text', () => {
    const ics = unfold(planToIcs(plan({ itinerary: [{ itemId: 'x', label: 'Lunch, then; a walk\\nice', location: 'Line one\nLine two', startAt: '2026-11-14T12:00:00Z', endAt: '2026-11-14T13:00:00Z' }] }), { now: NOW })!);
    expect(ics).toContain('SUMMARY:Lunch\\, then\\; a walk\\\\nice');
    expect(ics).toContain('LOCATION:Line one\\nLine two');
  });

  it('folds long lines at 75 bytes without splitting a character', () => {
    const long = 'Viewpoint café ☕ '.repeat(12);
    const ics = planToIcs(plan({ itinerary: [{ itemId: 'x', label: long, location: 'Somewhere', startAt: '2026-11-14T12:00:00Z', endAt: '2026-11-14T13:00:00Z' }] }), { now: NOW })!;
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(unfold(ics)).toContain(`SUMMARY:${long}`);
    expect(unfold(ics)).not.toContain('�');
  });

  it('keeps each stop\'s identity across revisions so a calendar updates it in place', () => {
    const a = unfold(planToIcs(plan({ revision: 12 }), { now: NOW })!);
    const b = unfold(planToIcs(plan({ revision: 13 }), { now: NOW })!);
    expect(a.match(/UID:[^\r\n]+/g)).toEqual(b.match(/UID:[^\r\n]+/g));
    expect(a).toContain('SEQUENCE:12');
    expect(b).toContain('SEQUENCE:13');
  });

  it('skips a stop whose time is missing or backwards, and returns nothing if no stop is usable', () => {
    const ics = planToIcs(plan({ itinerary: [
      { itemId: 'bad1', label: 'No time', location: 'x', startAt: 'soon', endAt: 'later' },
      { itemId: 'bad2', label: 'Backwards', location: 'x', startAt: '2026-11-14T12:00:00Z', endAt: '2026-11-14T11:00:00Z' },
      { itemId: 'ok', label: 'Fine', location: 'x', startAt: '2026-11-14T12:00:00Z', endAt: '2026-11-14T13:00:00Z' },
    ] }), { now: NOW })!;
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(planToIcs(plan({ itinerary: [] }), { now: NOW })).toBeUndefined();
    expect(planToIcs(plan({ itinerary: [{ itemId: 'b', label: 'x', location: 'x', startAt: 'nope', endAt: 'nope' }] }), { now: NOW })).toBeUndefined();
  });

  it('says nothing is booked and carries no money', () => {
    const ics = unfold(planToIcs(plan(), { now: NOW })!);
    expect(ics).toMatch(/nothing is booked/i);
    expect(ics).not.toMatch(/\$|budget|cap\b|cents|contribut/i);
  });

  it('names the trip in the calendar', () => {
    expect(unfold(planToIcs(plan(), { now: NOW })!)).toContain('X-WR-CALNAME:State park and small-town weekend');
  });
});
