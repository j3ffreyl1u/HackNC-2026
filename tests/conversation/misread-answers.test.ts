import { describe, expect, it } from 'vitest';
import { extractConstraints } from '../../src/conversation/constraints.js';

const REF = '2026-10-11T12:00:00Z';
const values = (text: string, pending?: Parameters<typeof extractConstraints>[2]) => extractConstraints(text, REF, pending).map((e) => e.value);

describe('short replies while waiting for a place are not saved as one', () => {
  it.each(['cancel', 'never mind', 'nvm', 'mostly food', 'tomorrow', 'maybe later', 'historical monuments and food', 'hiking and museums'])('"%s" is not an origin', (t) => {
    expect(values(t, 'origin')).toEqual([]);
  });
  it('"next weekend" while waiting for a place is dates, not a place', () => {
    expect(values('next weekend', 'origin').map((v) => v.field)).toEqual(['availability']);
  });
  it('reads "from Raleigh" as Raleigh', () => {
    expect(values('from Raleigh', 'origin')).toEqual([{ field: 'origin', value: 'Raleigh' }]);
    expect(values("I'm leaving from Raleigh", 'origin').some((v) => v.field === 'origin' && v.value === 'Raleigh')).toBe(true);
  });
  it('still takes a plain place', () => {
    expect(values('Raleigh', 'origin')).toEqual([{ field: 'origin', value: 'Raleigh' }]);
    expect(values('Chapel Hill', 'origin')).toEqual([{ field: 'origin', value: 'Chapel Hill' }]);
  });
});

describe('wanting to see a place and talking about the options are not likings', () => {
  it('"I\'d like to visit Boone" names a place', () => {
    expect(values("I'd like to visit Boone")).toEqual([{ field: 'region', value: 'Boone' }]);
  });
  it('keeps the liking and the place apart', () => {
    const v = values('I like hiking and I want to visit Boone');
    expect(v).toContainEqual({ field: 'region', value: 'Boone' });
    expect(v).toContainEqual({ field: 'preferences', value: ['hiking'] });
  });
  it.each(['I like the second one better', 'I like option 1', 'I love the first one'])('"%s" is not a liking', (t) => {
    expect(values(t).filter((v) => v.field === 'preferences')).toEqual([]);
  });
  it('still reads a real liking', () => {
    expect(values('I like hiking and food')).toEqual([{ field: 'preferences', value: ['hiking', 'food'] }]);
  });
});

describe('more ways to say a budget and dates', () => {
  it.each([['i can spend 300', 30000], ['I have 500 to spend', 50000], ['I got 250 for the trip', 25000], ['300 is my max', 30000], ['my budget is around 400', 40000], ['my max is $250', 25000]])('"%s"', (t, cents) => {
    expect(values(t)).toEqual([{ field: 'budget', value: cents }]);
  });
  it('does not read nights or dates as a budget', () => {
    expect(values('I can do 2 nights').some((v) => v.field === 'budget')).toBe(false);
    expect(values("I'm free Nov 14-16").some((v) => v.field === 'budget')).toBe(false);
  });
  it.each(['11/14-11/16', 'Nov 14th - 16th', 'Nov 14-16', 'Nov 14 to 16'])('"%s" alone is a date window', (t) => {
    expect(values(t)).toEqual([{ field: 'availability', value: [{ start: '2026-11-14', end: '2026-11-16' }] }]);
  });
});

describe('a budget split by category', () => {
  it.each([
    'my maximum total is $500 for food and $800 for travel',
    'I can spend $500 on food and $800 on travel',
    'my maxium total is $500 for food and $800 for travel (will splitting my costs change the calculations?)',
  ])('"%s" adds up to $1,300 and waits for a confirmation', (t) => {
    const found = extractConstraints(t, REF, 'budget');
    expect(found.map((e) => e.value)).toEqual([{ field: 'budget', value: 130000 }]);
    expect(found[0]!.hedged).toBe(true);
  });
});
