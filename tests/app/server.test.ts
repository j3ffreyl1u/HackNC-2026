import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TripEnrollment, TripState } from '../../src/contracts/index.js';
import { createHttpServer } from '../../src/app/server.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';

const dirs: string[] = [];

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'trip-http-'));
  dirs.push(directory);
  const repository = SqliteTripRepository.open(join(directory, 'trips.sqlite'));
  const enrollment: TripEnrollment = {
    tripId: 'trip-http', groupSpaceId: 'friends', participants: [
      { memberId: 'mason', displayName: 'Mason', providerUserId: 'provider-mason' },
    ],
  };
  const state: TripState = {
    tripId: 'trip-http', revision: 1, status: 'gathering',
    memberConstraints: [{ memberId: 'mason', field: 'budget', value: 20_000, sourceMessageId: 'private', certainty: 'confirmed', updatedAt: '2026-10-10T12:00:00Z' }],
    groupConstraints: [], candidates: [], acceptances: [], pendingQuestions: [], fundingStatus: 'disabled',
  };
  return { repository, enrollment, state };
}

describe('local HTTP server', () => {
  it('serves a safe public snapshot and returns 404 for an unknown trip', async () => {
    const { repository, enrollment, state } = setup();
    await repository.bootstrapTrip(enrollment, state);
    const server = createHttpServer({ repository });
    const port = await server.listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/trips/trip-http/snapshot`);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain('20000');
      expect(body).toMatchObject({ tripId: 'trip-http', revision: 1, participants: [{ memberId: 'mason', displayName: 'Mason' }] });
      expect((await fetch(`http://127.0.0.1:${port}/api/trips/unknown/snapshot`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    } finally {
      await server.close();
      repository.close();
    }
  });

  it('serves the approved plan as a calendar file, and nothing before it is approved', async () => {
    const { repository, enrollment, state } = setup();
    const candidate = {
      candidateId: 'cand-1', revision: 2, title: 'Park weekend', startAt: '2026-11-14T08:00:00-05:00', endAt: '2026-11-15T18:00:00-05:00',
      itinerary: [{ itemId: 's1', label: 'Day hike', location: 'State park', startAt: '2026-11-14T11:00:00-05:00', endAt: '2026-11-14T16:00:00-05:00', tags: ['hiking'], evidenceIds: [] }],
      costs: [], contingencyCents: 0, perPersonTotals: [], evidence: [], tradeoffs: [], feasibility: { feasible: true, violatedConstraints: [], unknownEssentials: [] },
    } as unknown as TripState['candidates'][number];
    await repository.bootstrapTrip(enrollment, state);
    const server = createHttpServer({ repository });
    const port = await server.listen(0);
    try {
      const url = `http://127.0.0.1:${port}/api/trips/trip-http/plan.ics`;
      expect((await fetch(url)).status).toBe(409);
      expect((await fetch(`http://127.0.0.1:${port}/api/trips/unknown/plan.ics`)).status).toBe(404);
      expect(await repository.saveTripIfRevision({ ...state, revision: 2, status: 'approved', selectedCandidateId: 'cand-1', candidates: [candidate] }, 1)).toBe(true);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^text\/calendar/);
      expect(response.headers.get('content-disposition')).toMatch(/attachment; filename="[^"]+\.ics"/);
      const body = await response.text();
      expect(body).toContain('BEGIN:VCALENDAR');
      expect(body).toContain('SUMMARY:Day hike');
      expect(body).toContain('DTSTART:20261114T160000Z');
      expect(body).not.toMatch(/20000|budget|cap\b/i);
    } finally {
      await server.close();
      repository.close();
    }
  });

  it('exposes no mutating demo controls from the public page', async () => {
    const { repository } = setup();
    const server = createHttpServer({ repository });
    const port = await server.listen(0);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/api/demo/advance-cycle`, { method: 'POST' })).status).toBe(404);
    } finally {
      await server.close();
      repository.close();
    }
  });
});
