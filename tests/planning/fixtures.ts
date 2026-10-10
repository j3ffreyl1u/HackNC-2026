import { recordConstraint } from '../../src/planning/constraints.js';
import { createTrip } from '../../src/planning/state.js';
import type {
  Certainty,
  ConstraintField,
  ConstraintUpdate,
  ConstraintValues,
  CostItem,
  TripAction,
  TripCandidate,
  TripCommand,
  TripState,
} from '../../src/planning/types.js';

export const roster = [
  { memberId: 'mason', displayName: 'Mason', consented: true },
  { memberId: 'alex', displayName: 'Alex', consented: true },
  { memberId: 'jordan', displayName: 'Jordan', consented: true },
];
export const ids = roster.map((m) => m.memberId);
export const NOW = '2026-10-10T12:00:00.000Z';
export const WEEKEND = { startAt: '2026-10-16T17:00:00.000Z', endAt: '2026-10-18T20:00:00.000Z' };
export const CAPS = { mason: 20_000, alex: 25_000, jordan: 30_000 } as Record<string, number>;

let counter = 0;
export const nextId = (prefix: string) => `${prefix}-${++counter}`;

export function update<F extends ConstraintField>(memberId: string, field: F, value: ConstraintValues[F], certainty: Certainty = 'confirmed'): ConstraintUpdate {
  return { memberId, field, value, sourceMessageId: nextId('m'), certainty } as ConstraintUpdate;
}

export function put<F extends ConstraintField>(state: TripState, memberId: string, field: F, value: ConstraintValues[F], certainty: Certainty = 'confirmed'): TripState {
  return recordConstraint(state, update(memberId, field, value, certainty), NOW);
}

/** The acceptance fixture with every readiness slot filled: caps 20,000 / 25,000 / 30,000, one weekend, a car. */
export function readyState(caps: Record<string, number> = CAPS): TripState {
  let state = createTrip('trip-1', roster);
  for (const id of ids) {
    state = put(state, id, 'budget', { cents: caps[id] });
    state = put(state, id, 'availability', { intervals: [WEEKEND] });
    state = put(state, id, 'preferences', { items: ['hiking', 'town visit'] });
    state = put(state, id, 'duration', { nights: 2 });
    state = put(state, id, 'origin', { city: 'Chapel Hill' });
    state = put(state, id, 'region', { searchRegion: 'NC mountains', maxTravelMinutes: 240 });
    state = put(state, id, 'transport', { mode: 'car', vehicleAvailable: true });
  }
  return state;
}

const food = (memberId: string): CostItem => ({
  costId: `food-${memberId}`, category: 'food', label: 'Food', lowCents: 1_500, highCents: 2_000,
  allocation: 'personal', memberId, evidenceIds: [], priceStatus: 'estimate',
});

/** Shared upper cost `sharedHigh`, 2,000 personal food each, 3,000 total contingency. */
export function candidate(candidateId: string, sharedHigh: number, tags: string[] = ['hiking'], overrides: Partial<TripCandidate> = {}): TripCandidate {
  return {
    candidateId, revision: 1, title: `Option ${candidateId}`, startAt: WEEKEND.startAt, endAt: WEEKEND.endAt,
    itinerary: [{ itemId: `${candidateId}-1`, label: 'Day out', location: 'Boone', startAt: WEEKEND.startAt, endAt: '2026-10-16T20:00:00.000Z', travelMinutesFromPrevious: 180, evidenceIds: [], tags }],
    costs: [
      { costId: 'cabin', category: 'accommodation', label: 'Cabin', lowCents: Math.round(sharedHigh * 0.8), highCents: sharedHigh, allocation: 'equal_shared', evidenceIds: [], priceStatus: 'estimate' },
      ...ids.map(food),
    ],
    contingencyCents: 3_000, perPersonTotals: [], evidence: [], tradeoffs: [],
    feasibility: { feasible: false, violations: [], unknownEssentials: [] }, dataSource: 'fixture', ...overrides,
  };
}

export function command(actorId: string, action: TripAction, tripId = 'trip-1'): TripCommand {
  return { commandId: nextId('cmd'), eventId: nextId('evt'), actorId, tripId, action };
}
