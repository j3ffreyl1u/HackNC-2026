import { describe, expect, it } from 'vitest';
import { drivingComparison, formatMinutes, outdoorSummary } from '../../src/planning/nature.js';
import type { ItineraryItem, TripCandidate } from '../../src/planning/types.js';
import { WEEKEND, candidate } from './fixtures.js';

const stop = (itemId: string, label: string, location: string, tags: string[], travelMinutesFromPrevious?: number): ItineraryItem => ({
  itemId, label, location, startAt: WEEKEND.startAt, endAt: WEEKEND.endAt, evidenceIds: [], tags,
  ...(travelMinutesFromPrevious !== undefined ? { travelMinutesFromPrevious } : {}),
});

function withStops(id: string, stops: ItineraryItem[], feasible = true): TripCandidate {
  const c = candidate(id, 45_000, ['hiking'], { itinerary: stops });
  return { ...c, feasibility: { feasible, violations: [], unknownEssentials: [] } };
}

describe('formatMinutes', () => {
  it('reads like a person would say it', () => {
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(200)).toBe('3h 20m');
  });
});

describe('outdoorSummary', () => {
  it('lists the outdoor stops and adds up the driving written into the plan', () => {
    const c = withStops('a', [
      stop('1', 'Drive to the park', 'Hanging Rock area', [], 150),
      stop('2', 'Day hike', 'State park', ['hiking'], 20),
      stop('3', 'Evening in town', 'Nearby small town', ['town visit'], 25),
    ]);
    const s = outdoorSummary(c);
    expect(s.outdoorStops.map((o) => o.label)).toEqual(['Day hike']);
    expect(s.drivingMinutes).toBe(195);
    expect(s.unknownLegs).toBe(0);
  });

  it('does not count a stop with an unknown drive as zero, and says so', () => {
    const c = withStops('a', [stop('1', 'Drive', 'Boone', [], 180), stop('2', 'Walk', 'Boone', ['trail'])]);
    const s = outdoorSummary(c);
    expect(s.drivingMinutes).toBe(180);
    expect(s.unknownLegs).toBe(1);
  });

  it('has no outdoor stops for a town-only plan', () => {
    const c = withStops('a', [stop('1', 'Drive', 'Asheville', [], 220), stop('2', 'Brewery walk', 'Downtown', ['breweries', 'town visit'], 10)]);
    expect(outdoorSummary(c).outdoorStops).toEqual([]);
  });
});

describe('drivingComparison', () => {
  const near = withStops('near', [stop('1', 'Drive', 'Hanging Rock', [], 150), stop('2', 'Day hike', 'State park', ['hiking'], 20)]);
  const far = withStops('far', [stop('1', 'Drive', 'Boone', [], 180), stop('2', 'Day hike', 'Grandfather', ['hiking'], 30)]);

  it('names the option with less driving, in minutes, from the plans\' own drive times', () => {
    const result = drivingComparison([far, near]);
    expect(result?.fewestDrivingId).toBe('near');
    expect(result?.savedMinutes).toBe(40);
    expect(result?.text).toMatch(/40m less driving/);
    expect(result?.text).toMatch(/Option near/);
  });

  it('claims no emissions and says what the minutes do not include', () => {
    const text = drivingComparison([far, near])!.text;
    expect(text).not.toMatch(/co2|carbon|emission|saves? \d+ ?(kg|lb|pounds)/i);
    expect(text).toMatch(/drive home is not counted/i);
  });

  it('only compares options that fit everyone, and says nothing without two to compare', () => {
    const infeasible = withStops('x', [stop('1', 'Drive', 'Near', [], 30)], false);
    expect(drivingComparison([far, infeasible])).toBeUndefined();
    expect(drivingComparison([near])).toBeUndefined();
  });

  it('refuses to compare when a drive time is unknown rather than treating it as zero', () => {
    const unknown = withStops('u', [stop('1', 'Drive', 'Somewhere', [])]);
    expect(drivingComparison([unknown, near])).toBeUndefined();
  });

  it('says when the options tie', () => {
    const twin = withStops('twin', [stop('1', 'Drive', 'Elsewhere', [], 150), stop('2', 'Walk', 'Park', ['hiking'], 20)]);
    const result = drivingComparison([near, twin]);
    expect(result?.savedMinutes).toBe(0);
    expect(result?.text).toMatch(/same amount of driving/i);
  });

  it('labels demo data', () => {
    expect(drivingComparison([far, near])!.text).toMatch(/demo data/i);
  });
});
