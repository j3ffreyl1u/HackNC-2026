import { describe, expect, it } from 'vitest';
import { loadDemoTrip, enrollmentWarnings } from '../../src/app/fixture.js';
import { summarizeStoredConstraints } from '../../src/app/diagnostics.js';

describe('live run diagnostics', () => {
  it('reports missing records without exposing amounts, dates or provider identities', async () => {
    const trip = await loadDemoTrip('tests/fixtures/trip.json');
    trip.state.memberConstraints = trip.state.memberConstraints.filter(r => r.memberId !== 'mason' || (r.field !== 'budget' && r.field !== 'availability'));
    const summary = summarizeStoredConstraints(trip.state);
    expect(summary.members.find(m => m.memberId === 'mason')?.budget.recordCount).toBe(0);
    expect(summary.members.find(m => m.memberId === 'alex')?.budget.confirmedRecordPresent).toBe(true);
    expect(JSON.stringify(summary)).not.toMatch(/25000|2026-11|providerUserId|sourceMessageId/);
  });
  it('warns about a one-person fixed enrollment without promising automatic onboarding', async () => {
    const trip = await loadDemoTrip('tests/fixtures/trip.json');
    expect(enrollmentWarnings(trip.enrollment)).toEqual([]);
    expect(enrollmentWarnings({ ...trip.enrollment, participants: trip.enrollment.participants.slice(0, 1) })[0]).toMatch(/texting the bot does not add/);
  });
});
