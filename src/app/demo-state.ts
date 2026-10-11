import type { TripState } from '../contracts/index.js';

/** For `npm run demo:web` only: turns the finished demo trip into an earlier stage so the page can be seen in every state. */
export function applyDemoStatus(finished: TripState, status: TripState['status']): TripState {
  const base = { ...finished, status };
  const { selectedCandidateId: _selected, ...withoutPick } = base;
  switch (status) {
    case 'approved': return finished;
    case 'awaiting_acceptance': return { ...base, acceptances: finished.acceptances.slice(0, 1) };
    case 'proposed': return { ...withoutPick, acceptances: [] };
    case 'researching': return { ...withoutPick, acceptances: [], candidates: [] };
    case 'gathering': {
      const last = finished.memberConstraints.at(-1)?.memberId;
      return { ...withoutPick, acceptances: [], candidates: [], groupConstraints: [], memberConstraints: finished.memberConstraints.filter(c => c.memberId !== last) };
    }
  }
}
