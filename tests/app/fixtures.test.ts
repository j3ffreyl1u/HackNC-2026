import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDemoTrip, type DemoTripFixture } from '../../src/app/fixture.js';

interface TripFixture {
  mockOnly: boolean;
  note: string;
  participants: Array<{
    memberId: string;
    budgetCapCents: number;
    availability: Array<{ startAt: string; endAt: string }>;
  }>;
  planningAcceptance: {
    sharedUpperCostsCents: number[];
    personalFoodUpperCentsPerPerson: number;
    contingencyCentsPerPerson: number;
    expectedUpperTotalsByOption: number[];
    revisedMasonBudgetCapCents: number;
    optionInvalidatedByRevisedCap: number;
  };
}

const fixture = JSON.parse(readFileSync('tests/fixtures/trip.json', 'utf8')) as TripFixture;

describe('sanitized travel acceptance fixture', () => {
  it('keeps all three caps, origins’ possible weekends, and the specified upper-cost math', () => {
    expect(fixture.mockOnly).toBe(true);
    expect(fixture.participants.map(({ budgetCapCents }) => budgetCapCents)).toEqual([20_000, 25_000, 30_000]);
    expect(fixture.participants.every(({ availability }) => availability.length === 2)).toBe(true);

    const { sharedUpperCostsCents, personalFoodUpperCentsPerPerson, contingencyCentsPerPerson, expectedUpperTotalsByOption } = fixture.planningAcceptance;
    expect(sharedUpperCostsCents.map((shared) => shared / 3 + personalFoodUpperCentsPerPerson + contingencyCentsPerPerson))
      .toEqual(expectedUpperTotalsByOption);
  });

  it('marks sample dates and destinations as synthetic, not sourced travel facts', () => {
    expect(fixture.note).toMatch(/synthetic/i);
    expect(fixture.note).toMatch(/not sourced research/i);
  });

  it('encodes the revision acceptance: lowering Mason’s cap excludes only the expensive option', () => {
    const { revisedMasonBudgetCapCents, optionInvalidatedByRevisedCap, expectedUpperTotalsByOption } = fixture.planningAcceptance;
    expect(expectedUpperTotalsByOption[optionInvalidatedByRevisedCap]).toBeGreaterThan(revisedMasonBudgetCapCents);
    expect(expectedUpperTotalsByOption.filter((amount) => amount <= revisedMasonBudgetCapCents)).toEqual([18_000]);
  });

  it('turns the sanitized fixture into actor-attributed state without placing caps in the public snapshot contract', () => {
    const data = buildDemoTrip(fixture as unknown as DemoTripFixture);
    expect(data.enrollment.participants.map(({ memberId }) => memberId)).toEqual(['mason', 'alex', 'jordan']);
    expect(data.state.memberConstraints.filter((item) => item.field === 'budget').map((item) => item.value)).toEqual([20_000, 25_000, 30_000]);
    expect(data.state.groupConstraints.map(({ field }) => field)).toEqual(['origin', 'region', 'duration', 'transport']);
  });
});
