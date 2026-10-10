import { describe, expect, it } from 'vitest';
import { parseDueDate } from '../../src/conversation/dates.js';

const ref = '2026-10-01T12:00:00Z';
describe('parseDueDate', () => {
  it.each([
    ['2026-10-15', '2026-10-15'], ['Oct 15', '2026-10-15'], ['October 15th', '2026-10-15'], ['oct. 15', '2026-10-15'],
    ['15 Oct', '2026-10-15'], ['10/15', '2026-10-15'], ['10/15/2026', '2026-10-15'], ['Sept 3', '2026-09-03'], ['Oct 15, 2027', '2027-10-15'],
  ])('%s -> %s', (i, o) => expect(parseDueDate(i, ref)).toBe(o));
  it('rolls long-past dates into next year but keeps recent ones', () => {
    expect(parseDueDate('Jan 5', ref)).toBe('2027-01-05');
    expect(parseDueDate('Sep 25', ref)).toBe('2026-09-25');
  });
  it.each(['Oct 32', 'Feb 30', 'Foo 15', '13/40', 'soon', 'Octopus 5', ''])('rejects %s', (i) => expect(parseDueDate(i, ref)).toBeNull());
});
