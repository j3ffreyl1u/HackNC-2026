import type { Repository, TripState } from '../contracts/index.js';

/**
 * For `npm run demo:web` only: turns the finished demo trip into an earlier stage so the page can be seen in every state.
 * `revision` is the revision the stage will be saved at; every candidate, selection and acceptance is stamped with it so
 * the page never shows "Revision 13" beside a plan "revision 12". `emptyCandidates` shows a stage with nothing found.
 */
export function applyDemoStatus(finished: TripState, status: TripState['status'], options: { revision?: number; emptyCandidates?: boolean } = {}): TripState {
  const revision = options.revision ?? finished.revision;
  const restamp = (state: TripState): TripState => ({
    ...state,
    revision,
    candidates: state.candidates.map((c) => ({ ...c, revision })),
    acceptances: state.acceptances.map((a) => ({ ...a, revision })),
  });
  const base = { ...finished, status };
  const { selectedCandidateId: _selected, ...withoutPick } = base;
  const stage = ((): TripState => {
    switch (status) {
      case 'approved': return finished;
      case 'awaiting_acceptance': return { ...base, acceptances: finished.acceptances.slice(0, 1) };
      case 'proposed': return { ...withoutPick, acceptances: [] };
      case 'researching': return { ...withoutPick, acceptances: [], candidates: [] };
      case 'gathering': {
        const last = finished.memberConstraints.at(-1)?.memberId;
        return { ...withoutPick, acceptances: [], candidates: [], groupConstraints: [], memberConstraints: finished.memberConstraints.filter((c) => c.memberId !== last) };
      }
    }
  })();
  const emptied = options.emptyCandidates && status !== 'approved' ? { ...stage, candidates: [], acceptances: [], selectedCandidateId: undefined } : stage;
  const { selectedCandidateId, ...rest } = emptied;
  return restamp(selectedCandidateId ? { ...rest, selectedCandidateId } : rest as TripState);
}

/** Saves the stage as the next revision of the finished demo trip. */
export async function saveDemoStage(repository: Repository, finished: TripState, status: TripState['status'], options: { emptyCandidates?: boolean } = {}): Promise<void> {
  if (status === 'approved') return;
  const next = applyDemoStatus(finished, status, { revision: finished.revision + 1, ...options });
  if (!(await repository.saveTripIfRevision(next, finished.revision))) throw new Error('The demo trip changed while it was being set up.');
}
