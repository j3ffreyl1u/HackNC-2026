import { describe, expect, it } from 'vitest';
import { extractConstraints, parseMaxTravelMinutes } from '../../src/conversation/constraints.js';

const ref = '2026-10-01T12:00:00Z';
const ex = (t: string, p?: Parameters<typeof extractConstraints>[2]) => extractConstraints(t, ref, p);
const one = (t: string, field: string, p?: Parameters<typeof extractConstraints>[2]) => ex(t, p).find((e) => e.value.field === field);

describe('budget', () => {
  it.each([
    ['my budget is $200', 20000],
    ['I can spend up to $250.50 total', 25050],
    ['$300 max for me', 30000],
    ['max 180 dollars', 18000],
    ['cap: 200', 20000],
  ])('%s -> %i cents', (t, cents) => {
    expect(one(t, 'budget')).toMatchObject({ value: { field: 'budget', value: cents }, hedged: false });
  });
  it('does not mistake costs, dates or durations for a budget', () => {
    expect(one('gas will be about $40', 'budget')).toBeUndefined();
    expect(one('I can do Oct 17-19', 'budget')).toBeUndefined();
    expect(one('2 nights, max 3 hours', 'budget')).toBeUndefined();
  });
  it('flags tentative budget wording', () => {
    expect(one('maybe around $200?', 'budget')).toBeUndefined(); // no budget keyword, no pending question
    expect(one('I might be able to spend up to $200', 'budget')?.hedged).toBe(true);
  });
  it('reads a bare amount only as the answer to a pending budget question', () => {
    expect(one('250', 'budget')).toBeUndefined();
    expect(one('250', 'budget', 'budget')).toMatchObject({ value: { value: 25000 } });
    expect(one('$250 maybe', 'budget', 'budget')?.hedged).toBe(true);
  });
  it('keeps only the first value per field', () => {
    expect(ex('budget $200. actually budget $300').filter((e) => e.value.field === 'budget')).toHaveLength(1);
  });
});

describe('availability', () => {
  it('extracts windows from availability wording', () => {
    expect(one("I'm free Oct 17-19 or Oct 24-26", 'availability')?.value).toEqual({
      field: 'availability',
      value: [{ start: '2026-10-17', end: '2026-10-19' }, { start: '2026-10-24', end: '2026-10-26' }],
    });
  });
  it('ignores dates that are not about availability, and flags unavailability', () => {
    expect(one('the game is on Oct 17', 'availability')).toBeUndefined();
    expect(one("can't do Oct 17-19", 'availability')?.negative).toBe(true);
  });
  it('accepts a bare window when availability was just asked', () => {
    expect(one('Oct 17-19', 'availability', 'availability')).toBeDefined();
  });
  it('splits sentences so a tentative one does not taint a plain one', () => {
    const r = ex("I'm free Oct 17-19. Maybe Oct 24-26?");
    expect(r.map((e) => e.hedged)).toEqual([false]); // one value per field: first sentence wins
  });
});

describe('other fields', () => {
  it('trip basics', () => {
    expect(one('we want 2 nights', 'duration')?.value).toMatchObject({ value: 2 });
    expect(one('leaving from Chapel Hill on Friday', 'origin')?.value).toMatchObject({ value: 'Chapel Hill' });
    expect(one('nothing farther than 3 hours', 'region')).toBeUndefined();
    expect(one('within 3 hours of Chapel Hill', 'region')?.value).toMatchObject({ value: 'within 3 hours by car', maxTravelMinutes: 180 });
    expect(one('within 1.5 hours', 'region')?.value).toMatchObject({ maxTravelMinutes: 90 });
    expect(one('region: Asheville area', 'region')?.value).toEqual({ field: 'region', value: 'Asheville area' }); // no limit stated, none invented
    expect(one('I have a car', 'transport')?.value).toMatchObject({ value: 'own_vehicle', vehicleAvailable: true });
    expect(one("I don't have a car", 'transport')?.value).toMatchObject({ value: 'no_vehicle', vehicleAvailable: false });
  });
  it('preferences, must-dos, dietary', () => {
    expect(one('I like hiking and a town visit', 'preferences')?.value).toMatchObject({ value: ['hiking', 'town visit'] });
    expect(one('I like that idea', 'preferences')).toBeUndefined();
    expect(one("no preference, I'm easy", 'preferences')?.value).toMatchObject({ value: ['no preference'] });
    expect(one('must see a waterfall', 'must_dos')?.value).toMatchObject({ value: ['waterfall'] });
    expect(one("I'm vegetarian", 'must_dos')?.value).toMatchObject({ value: ['vegetarian'] });
  });
  it('answers to pending questions', () => {
    expect(one('2', 'duration', 'duration')?.value).toMatchObject({ value: 2 });
    expect(one('Chapel Hill', 'origin', 'origin')?.value).toMatchObject({ value: 'Chapel Hill' });
    expect(one('hiking, good food', 'preferences', 'preferences')?.value).toMatchObject({ value: ['hiking', 'good food'] });
    expect(one('none', 'must_dos', 'must_dos')?.value).toMatchObject({ value: [] });
  });
  it('ordinary chatter yields nothing', () => {
    expect(ex('lol that was so funny')).toEqual([]);
  });
});

describe('parseMaxTravelMinutes', () => {
  it('reads hours and minutes, rejects implausible values', () => {
    expect(parseMaxTravelMinutes('within 3 hours')).toBe(180);
    expect(parseMaxTravelMinutes('2 hr drive')).toBe(120);
    expect(parseMaxTravelMinutes('within 90 minutes')).toBe(90);
    expect(parseMaxTravelMinutes('5 minutes')).toBeUndefined();
    expect(parseMaxTravelMinutes('Asheville')).toBeUndefined();
  });
});
