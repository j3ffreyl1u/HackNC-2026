import { describe, expect, it } from 'vitest';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { runMockDemo } from '../../src/app/mock-demo.js';
import { saveDemoStage } from '../../src/app/demo-state.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';

const STAGES = ['gathering', 'researching', 'proposed', 'awaiting_acceptance', 'approved'] as const;
/** What the page would be served: the demo trip saved at a stage, read back as the public snapshot. */
async function snapshot(stage: (typeof STAGES)[number], options: { emptyCandidates?: boolean } = {}) {
  const repository = SqliteTripRepository.open(':memory:');
  const trip = await loadDemoTrip('tests/fixtures/trip.json');
  await runMockDemo(repository, trip.enrollment, trip.state, {});
  const finished = (await repository.loadTrip(trip.state.tripId))!;
  await saveDemoStage(repository, finished, stage, options);
  const snap = (await repository.getPublicSnapshot(trip.state.tripId))!;
  return { snap, finished, repository };
}

describe('demo stages as the page sees them', () => {
  it('every candidate, selection and acceptance carries the snapshot revision', async () => {
    for (const stage of STAGES) {
      const { snap } = await snapshot(stage);
      expect(snap.status).toBe(stage);
      for (const c of snap.candidates) expect(c.revision, stage).toBe(snap.revision);
      for (const a of snap.acceptances) expect(a.revision, stage).toBe(snap.revision);
      if (snap.selectedCandidate) expect(snap.selectedCandidate.revision, stage).toBe(snap.revision);
    }
  });
  it('approved stays the finished trip', async () => {
    const { snap, finished } = await snapshot('approved');
    expect(snap.revision).toBe(finished.revision); expect(snap.acceptances).toHaveLength(3); expect(snap.selectedCandidate).toBeDefined();
  });
  it('awaiting_acceptance keeps the pick and only the first acceptance', async () => {
    const { snap, finished } = await snapshot('awaiting_acceptance');
    expect(snap.selectedCandidate?.candidateId).toBe(finished.selectedCandidateId); expect(snap.acceptances).toHaveLength(1);
  });
  it('proposed has options, no pick and no acceptances; researching and gathering have no options', async () => {
    const proposed = (await snapshot('proposed')).snap;
    expect(proposed.candidates.length).toBeGreaterThan(0); expect(proposed.selectedCandidate).toBeUndefined(); expect(proposed.acceptances).toEqual([]);
    for (const stage of ['researching', 'gathering'] as const) { const { snap } = await snapshot(stage); expect(snap.candidates, stage).toEqual([]); expect(snap.selectedCandidate).toBeUndefined(); }
  });
  it('gathering is missing one person', async () => {
    const { repository, finished } = await snapshot('gathering');
    const next = (await repository.loadTrip(finished.tripId))!;
    expect(new Set(next.memberConstraints.map((c) => c.memberId)).size).toBe(new Set(finished.memberConstraints.map((c) => c.memberId)).size - 1);
    expect(next.groupConstraints).toEqual([]);
  });
  it('the empty-candidates case has none at the stages that could have some', async () => {
    for (const stage of ['proposed', 'awaiting_acceptance'] as const) {
      const { snap } = await snapshot(stage, { emptyCandidates: true });
      expect(snap.candidates, stage).toEqual([]); expect(snap.selectedCandidate).toBeUndefined(); expect(snap.acceptances).toEqual([]);
    }
  });
});
