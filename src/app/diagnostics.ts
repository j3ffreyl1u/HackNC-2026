import type { TripState } from '../contracts/index.js';

/** Operator diagnostics expose record presence, never constraint values or private message content. */
export function summarizeStoredConstraints(state: TripState) {
  const memberIds = [...new Set([...(state.roster ?? []).map(m => m.memberId), ...state.memberConstraints.map(r => r.memberId)])];
  return {
    tripId: state.tripId, revision: state.revision, status: state.status,
    members: memberIds.map(memberId => {
      const records = state.memberConstraints.filter(r => r.memberId === memberId);
      const summary = (field: 'budget' | 'availability') => {
        const matching = records.filter(r => r.field === field);
        return { recordCount: matching.length, confirmedRecordPresent: matching.some(r => r.certainty === 'confirmed'), latestCertainty: matching.at(-1)?.certainty ?? 'absent' };
      };
      return { memberId, budget: summary('budget'), availability: summary('availability') };
    }),
  };
}
