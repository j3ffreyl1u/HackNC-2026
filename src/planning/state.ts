import type { MemberId, RosterMember, TripState } from './types.js';

/** A new trip. Revision 1; nothing is known yet and funding is off until someone explicitly asks. */
export function createTrip(tripId: string, roster: RosterMember[]): TripState {
  return {
    tripId,
    revision: 1,
    status: 'gathering',
    roster: roster.map((m) => ({ ...m })),
    memberConstraints: Object.fromEntries(roster.map((m) => [m.memberId, []])),
    groupConstraints: [],
    candidates: [],
    acceptances: [],
    pendingQuestions: [],
    fundingStatus: 'disabled',
  };
}

/** Members who consented to the bot processing trip messages. Only they take part in the plan. */
export function participants(state: TripState): RosterMember[] {
  return state.roster.filter((m) => m.consented);
}

export function participantIds(state: TripState): MemberId[] {
  return participants(state).map((m) => m.memberId);
}

export function displayName(state: TripState, memberId: MemberId): string {
  return state.roster.find((m) => m.memberId === memberId)?.displayName ?? memberId;
}
