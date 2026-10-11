import { loadDemoTrip } from '../../src/app/fixture.js';
import type { TripCandidate } from '../../src/contracts/index.js';
export async function approved() {
  const { state } = await loadDemoTrip('tests/fixtures/trip.json');
  const candidates: TripCandidate[] = [{ candidateId: 'fund-fixture', revision: state.revision, title: 'Synthetic fund fixture', startAt: '2026-11-14T00:00:00Z', endAt: '2026-11-17T00:00:00Z', itinerary: [], costs: [{ costId: 'lodging', category: 'accommodation', label: 'Synthetic lodging', lowCents: 9000, highCents: 12000, allocation: 'equal_shared', priceStatus: 'estimate', evidenceIds: [] }, { costId: 'fuel', category: 'transport', label: 'Synthetic fuel', lowCents: 6000, highCents: 9000, allocation: 'equal_shared', priceStatus: 'estimate', evidenceIds: [] }, { costId: 'fun', category: 'activity', label: 'Synthetic activities', lowCents: 3000, highCents: 6000, allocation: 'equal_shared', priceStatus: 'estimate', evidenceIds: [] }], contingencyCents: 1500, perPersonTotals: [], evidence: [], tradeoffs: [], feasibility: { feasible: true, violatedConstraints: [], unknownEssentials: [] } }];
  return { ...state, status: 'approved' as const, selectedCandidateId: candidates[0].candidateId, candidates };
}
