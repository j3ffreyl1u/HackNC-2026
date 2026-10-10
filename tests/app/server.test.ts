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
