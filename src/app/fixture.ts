import { readFile } from 'node:fs/promises';
import type {
  AvailabilityWindow,
  StoredConstraintValueByField as ConstraintValueByField,
  MemberConstraintRecord,
  TripEnrollment,
  TripState,
} from '../contracts/index.js';

export interface DemoTripFixture {
  tripId: string;
  groupSpaceId: string;
  revision: number;
  participants: Array<{
    memberId: string;
    displayName: string;
    providerUserId: string;
    budgetCapCents: number;
    origin: ConstraintValueByField['origin'];
    availability: AvailabilityWindow[];
    preferences: string[];
    mustDos: string[];
    consentedAt?: string;
  }>;
  groupConstraints: {
    durationNights: number;
    transport: ConstraintValueByField['transport'];
    destinationRegion: ConstraintValueByField['region'];
  };
}

export interface DemoTripData {
  enrollment: TripEnrollment;
  state: TripState;
}

export async function loadDemoTrip(path: string): Promise<DemoTripData> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  return buildDemoTrip(raw as DemoTripFixture);
}

/** Live enrollment is a fixed configured phone list; chat gathers the planning constraints. */
export async function loadEnrolledTrip(path: string): Promise<DemoTripData> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as { tripId: string; groupSpaceId: string; timeZone?: string; participants: TripEnrollment['participants'] };
  if (!raw.tripId?.trim() || !raw.groupSpaceId?.trim() || raw.groupSpaceId.startsWith('mock-') || !Array.isArray(raw.participants) || !raw.participants.length) throw new Error('Live enrollment needs a trip ID, actual group space ID and a fixed participant list.');
  const timeZone = raw.timeZone ?? 'America/New_York';
  new Intl.DateTimeFormat('en', { timeZone });
  const members = new Set<string>(), phones = new Set<string>();
  for (const p of raw.participants) {
    if (!p.memberId?.trim() || !p.displayName?.trim() || !/^\+[1-9]\d{7,14}$/.test(p.providerUserId) || !p.consentedAt || !Number.isFinite(Date.parse(p.consentedAt))) throw new Error('Each live participant needs an internal ID, name, E.164 phone number and recorded consent timestamp.');
    if (members.has(p.memberId) || phones.has(p.providerUserId)) throw new Error('Live participant IDs and phone numbers must be unique.');
    members.add(p.memberId); phones.add(p.providerUserId);
  }
  const enrollment: TripEnrollment = { tripId: raw.tripId, groupSpaceId: raw.groupSpaceId, participants: raw.participants.map(p => ({ memberId: p.memberId, displayName: p.displayName, providerUserId: p.providerUserId, consentedAt: p.consentedAt })) };
  return { enrollment, state: { tripId: raw.tripId, revision: 0, status: 'gathering', timeZone, roster: enrollment.participants.map(p => ({ memberId: p.memberId, displayName: p.displayName, consented: true })), memberConstraints: [], groupConstraints: [], candidates: [], acceptances: [], pendingQuestions: [], fundingStatus: 'disabled' } };
}

export function buildDemoTrip(fixture: DemoTripFixture): DemoTripData {
  if (!fixture || typeof fixture.tripId !== 'string' || !fixture.tripId.trim()) throw new Error('Fixture needs a trip ID.');
  if (typeof fixture.groupSpaceId !== 'string' || !fixture.groupSpaceId.trim()) throw new Error('Fixture needs a group space ID.');
  if (!Number.isSafeInteger(fixture.revision) || fixture.revision < 0) throw new Error('Fixture revision must be a non-negative integer.');
  if (!Array.isArray(fixture.participants) || fixture.participants.length !== 3) throw new Error('The demo fixture must enroll exactly three participants.');
  if (!fixture.groupConstraints || !fixture.groupConstraints.destinationRegion || !fixture.groupConstraints.transport) {
    throw new Error('Fixture needs destination-region and transport constraints.');
  }

  const memberIds = new Set<string>();
  const providerIds = new Set<string>();
  for (const participant of fixture.participants) {
    if (!participant.memberId?.trim() || !participant.displayName?.trim() || !participant.providerUserId?.trim()) {
      throw new Error('Every fixture participant needs an internal ID, display name, and provider ID.');
    }
    if (memberIds.has(participant.memberId) || providerIds.has(participant.providerUserId)) throw new Error('Fixture participant IDs must be unique.');
    memberIds.add(participant.memberId);
    providerIds.add(participant.providerUserId);
    if (!Number.isSafeInteger(participant.budgetCapCents) || participant.budgetCapCents <= 0) throw new Error(`Invalid budget cap for ${participant.memberId}.`);
    if (!Array.isArray(participant.availability) || participant.availability.length === 0 || participant.availability.some((window) => !validWindow(window))) {
      throw new Error(`Participant ${participant.memberId} needs valid manually stated availability windows.`);
    }
  }
  const firstOrigin = fixture.participants[0].origin;
  if (fixture.participants.some((participant) => JSON.stringify(participant.origin) !== JSON.stringify(firstOrigin))) {
    throw new Error('Demo participants must share the configured departure origin.');
  }
  if (!Number.isSafeInteger(fixture.groupConstraints.durationNights) || fixture.groupConstraints.durationNights <= 0) {
    throw new Error('Trip duration must be a positive whole number of nights.');
  }
  if (fixture.groupConstraints.destinationRegion.maxTravelMinutes === undefined || !Number.isSafeInteger(fixture.groupConstraints.destinationRegion.maxTravelMinutes) || fixture.groupConstraints.destinationRegion.maxTravelMinutes <= 0) {
    throw new Error('The destination region needs a positive maximum travel time.');
  }

  const enrollment: TripEnrollment = {
    tripId: fixture.tripId,
    groupSpaceId: fixture.groupSpaceId,
    participants: fixture.participants.map(({ memberId, displayName, providerUserId, consentedAt }) => ({
      memberId, displayName, providerUserId, ...(consentedAt ? { consentedAt } : {}),
    })),
  };
  const memberConstraints: MemberConstraintRecord[] = fixture.participants.flatMap((participant) => {
    const common = { memberId: participant.memberId, certainty: 'confirmed' as const, updatedAt: participant.consentedAt ?? '2026-10-10T12:00:00-04:00' };
    const provenance = (field: string) => ({ sourceMessageId: `fixture:${participant.memberId}:${field}` });
    return [
      { ...common, ...provenance('budget'), field: 'budget', value: participant.budgetCapCents },
      { ...common, ...provenance('availability'), field: 'availability', value: participant.availability },
      { ...common, ...provenance('preferences'), field: 'preferences', value: participant.preferences },
      { ...common, ...provenance('must_dos'), field: 'must_dos', value: participant.mustDos },
    ] as MemberConstraintRecord[];
  });
  const sourceMessageId = 'fixture:group-constraints';
  const memberId = fixture.participants[0].memberId;
  const state: TripState = {
    timeZone: firstOrigin.timeZone,
    roster: enrollment.participants.map(p => ({ memberId: p.memberId, displayName: p.displayName, consented: Boolean(p.consentedAt) })),
    tripId: fixture.tripId,
    revision: fixture.revision,
    status: 'gathering',
    memberConstraints,
    groupConstraints: [
      { memberId, field: 'origin', value: firstOrigin, sourceMessageId, certainty: 'confirmed' },
      { memberId, field: 'region', value: fixture.groupConstraints.destinationRegion, sourceMessageId, certainty: 'confirmed' },
      { memberId, field: 'duration', value: { nights: fixture.groupConstraints.durationNights }, sourceMessageId, certainty: 'confirmed' },
      { memberId, field: 'transport', value: fixture.groupConstraints.transport, sourceMessageId, certainty: 'confirmed' },
    ],
    candidates: [],
    acceptances: [],
    pendingQuestions: [],
    fundingStatus: 'disabled',
  };
  return { enrollment, state };
}

function validWindow(window: AvailabilityWindow): boolean {
  const start = Date.parse(window.startAt);
  const end = Date.parse(window.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: window.timeZone });
    return true;
  } catch {
    return false;
  }
}
