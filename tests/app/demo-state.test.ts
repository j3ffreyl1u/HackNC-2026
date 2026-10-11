import { describe, expect, it } from 'vitest';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { runMockDemo } from '../../src/app/mock-demo.js';
import { applyDemoStatus } from '../../src/app/demo-state.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';

async function approved() {
  const repository = SqliteTripRepository.open(':memory:');
  const trip = await loadDemoTrip('tests/fixtures/trip.json');
  await runMockDemo(repository, trip.enrollment, trip.state, {});
  return { state: (await repository.loadTrip(trip.state.tripId))!, enrollment: trip.enrollment };
}

describe('applyDemoStatus', () => {
  it('approved keeps the finished trip', async () => {
    const { state } = await approved();
    expect(applyDemoStatus(state, 'approved')).toEqual(state);
  });
  it('awaiting_acceptance keeps the pick and only the first acceptance', async () => {
    const { state } = await approved();
    const next = applyDemoStatus(state, 'awaiting_acceptance');
    expect(next.status).toBe('awaiting_acceptance');
    expect(next.selectedCandidateId).toBe(state.selectedCandidateId);
    expect(next.acceptances).toHaveLength(1);
    expect(next.acceptances[0]).toEqual(state.acceptances[0]);
  });
  it('proposed has candidates, no pick and no acceptances', async () => {
    const { state } = await approved();
    const next = applyDemoStatus(state, 'proposed');
    expect(next.candidates.length).toBeGreaterThan(0);
    expect(next.selectedCandidateId).toBeUndefined();
    expect(next.acceptances).toEqual([]);
  });
  it('researching has no candidates yet', async () => {
    const { state } = await approved();
    const next = applyDemoStatus(state, 'researching');
    expect(next).toMatchObject({ status: 'researching', candidates: [], acceptances: [] });
    expect(next.selectedCandidateId).toBeUndefined();
  });
  it('gathering is missing one person and the group facts', async () => {
    const { state } = await approved();
    const next = applyDemoStatus(state, 'gathering');
    expect(next).toMatchObject({ status: 'gathering', candidates: [], acceptances: [] });
    expect(next.groupConstraints).toEqual([]);
    const people = new Set(next.memberConstraints.map(c => c.memberId));
    expect(people.size).toBe(new Set(state.memberConstraints.map(c => c.memberId)).size - 1);
  });
});
