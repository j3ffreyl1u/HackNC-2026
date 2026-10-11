import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TripEnrollment, TripState } from '../../src/contracts/index.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';

const directories: string[] = [];

function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'travel-planner-'));
  directories.push(directory);
  return SqliteTripRepository.open(join(directory, 'trips.sqlite'));
}

const enrollment: TripEnrollment = {
  tripId: 'trip-1',
  groupSpaceId: 'friends',
  participants: [
    { memberId: 'mason', displayName: 'Mason', providerUserId: 'provider-mason' },
    { memberId: 'alex', displayName: 'Alex', providerUserId: 'provider-alex' },
    { memberId: 'jordan', displayName: 'Jordan', providerUserId: 'provider-jordan' },
  ],
};

function initialState(): TripState {
  return {
    tripId: 'trip-1', revision: 1, status: 'proposed',
    memberConstraints: [
      { memberId: 'mason', field: 'budget', value: 20_000, sourceMessageId: 'private-budget', certainty: 'confirmed', updatedAt: '2026-10-10T12:00:00Z' },
    ],
    groupConstraints: [],
    candidates: [{
      candidateId: 'candidate-1', revision: 1, title: 'Weekend option',
      startAt: '2026-11-14T08:00:00-05:00', endAt: '2026-11-15T21:00:00-05:00',
      itinerary: [], costs: [], contingencyCents: 0,
      perPersonTotals: [{ memberId: 'mason', lowCents: 18_000, highCents: 19_000 }],
      evidence: [{ evidenceId: 'fixture-1', url: 'https://example.invalid/fixture', title: 'Mock source', retrievedAt: '2026-10-10T12:00:00Z', kind: 'estimate', claim: 'Synthetic test evidence', uncertainty: 'Fixture only' }],
      tradeoffs: ['Synthetic fixture'], feasibility: { feasible: true, violatedConstraints: [], unknownEssentials: [] },
    }],
    selectedCandidateId: 'candidate-1', acceptances: [], pendingQuestions: [], fundingStatus: 'disabled',
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('SQLite trip repository', () => {
  it('persists revisions and evidence across reopen while keeping private caps out of snapshots', async () => {
    const first = repository();
    await first.bootstrapTrip(enrollment, initialState());
    const snapshot = await first.getPublicSnapshot('trip-1');
    expect(snapshot?.participants.map((person) => person.displayName)).toEqual(['Mason', 'Alex', 'Jordan']);
    expect(snapshot?.selectedCandidate?.evidence[0].claim).toBe('Synthetic test evidence');
    expect(JSON.stringify(snapshot)).not.toContain('20000');
    first.close();

    const reopened = SqliteTripRepository.open(join(directories[0], 'trips.sqlite'));
    try {
      const state = await reopened.loadTrip('trip-1');
      expect(state?.memberConstraints[0]).toMatchObject({ field: 'budget', value: 20_000 });
      expect(state?.revision).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it('commits event, next revision, and outbox atomically and deduplicates replay', async () => {
    const store = repository();
    try {
      await store.bootstrapTrip(enrollment, initialState());
      const next = { ...initialState(), revision: 2, status: 'awaiting_acceptance' as const };
      const message = { deliveryId: 'delivery-1', audience: { kind: 'group' as const, spaceId: 'friends' }, text: 'Review candidate', proposalRef: { candidateId: 'candidate-1', revision: 2 } };
      const event = { eventId: 'event-1', state: next, expectedRevision: 1, messages: [message] };
      expect(await store.commitEvent(event)).toBe('committed');
      expect(await store.commitEvent(event)).toBe('duplicate');
      expect((await store.loadTrip('trip-1'))?.revision).toBe(2);
      expect(await store.pendingMessages()).toEqual([message]);

      await store.recordDelivery('delivery-1', ['provider-message-1']);
      expect(await store.pendingMessages()).toEqual([]);
      expect(await store.lookupProposal('provider-message-1')).toEqual({ candidateId: 'candidate-1', revision: 2 });
      await expect(store.recordDelivery('delivery-1', ['different-provider-message'])).rejects.toThrow(/different provider message IDs/);
    } finally {
      store.close();
    }
  });

  it('rejects stale writes and does not mark a stale event processed', async () => {
    const store = repository();
    try {
      await store.bootstrapTrip(enrollment, initialState());
      const stale = { ...initialState(), revision: 2 };
      expect(await store.commitEvent({ eventId: 'stale-event', state: stale, expectedRevision: 0, messages: [] })).toBe('stale');
      expect(await store.commitEvent({ eventId: 'stale-event', state: stale, expectedRevision: 1, messages: [] })).toBe('committed');
    } finally {
      store.close();
    }
  });
});
