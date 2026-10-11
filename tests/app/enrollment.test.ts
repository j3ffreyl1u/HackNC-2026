import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnrolledTrip } from '../../src/app/fixture.js';

describe('fixed live enrollment', () => {
  it('accepts a phone whitelist and gathers constraints rather than using synthetic values', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trip-enrollment-'));
    try {
      const path = join(directory, 'trip.json');
      const config = { tripId: 'trip', groupSpaceId: 'actual-group', participants: [{ memberId: 'alex', displayName: 'Alex', providerUserId: '+15551234567', consentedAt: '2026-10-10T12:00:00-04:00' }] };
      writeFileSync(path, JSON.stringify(config));
      const trip = await loadEnrolledTrip(path);
      expect(trip.enrollment.participants).toEqual(config.participants);
      expect(trip.state.status).toBe('gathering');
      expect(trip.state.memberConstraints).toEqual([]);
      expect(trip.state.groupConstraints).toEqual([]);
      writeFileSync(path, JSON.stringify({ ...config, participants: [{ ...config.participants[0], providerUserId: 'mock-alex' }] }));
      await expect(loadEnrolledTrip(path)).rejects.toThrow(/E.164/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
