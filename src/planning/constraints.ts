import { assertPositiveCents, MoneyError } from './money.js';
import { participantIds } from './state.js';
import {
  GROUP_FIELDS,
  MEMBER_FIELDS,
  NO_PREFERENCE,
  type ConstraintField,
  type ConstraintRecord,
  type ConstraintUpdate,
  type ConstraintValues,
  type Interval,
  type MemberId,
  type TripErrorCode,
  type TripState,
} from './types.js';

/** An ordinary invalid constraint. Carries the code and the words to say to the person. */
export class ConstraintError extends Error {
  constructor(
    readonly code: Extract<TripErrorCode, 'INVALID_CONSTRAINT' | 'UNKNOWN_MEMBER'>,
    readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = 'ConstraintError';
  }
}

const invalid = (message: string): never => {
  throw new ConstraintError('INVALID_CONSTRAINT', message);
};

const MAX_TEXT = 80;
const MAX_ITEMS = 20;
const MAX_NIGHTS = 30;
const MAX_TRAVEL_MINUTES = 24 * 60;
const MS_PER_HOUR = 60 * 60 * 1000;
const HOURS_PER_NIGHT = 24;

// ---- text and time helpers ------------------------------------------------------------------------

function cleanText(value: unknown, label: string): string {
  if (typeof value !== 'string') return invalid(`${label} must be text.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return invalid(`${label} contains characters I can't use.`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return invalid(`${label} can't be empty.`);
  if (text.length > MAX_TEXT) return invalid(`${label} is too long.`);
  return text;
}

function cleanList(value: unknown, label: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value)) return invalid(`${label} must be a list.`);
  if (value.length > MAX_ITEMS) return invalid(`${label} has too many items.`);
  const items = [...new Set(value.map((item) => cleanText(item, label).toLowerCase()))].sort();
  if (items.length === 0 && !allowEmpty) return invalid(`${label} can't be empty.`);
  return items;
}

const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Epoch milliseconds for an ISO 8601 timestamp that states its timezone, or null if it is not one. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_WITH_OFFSET.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Sorted, non-overlapping intervals; touching or overlapping ones are merged. Input times must carry an offset. */
export function normalizeIntervals(intervals: readonly Interval[], label = 'availability'): Interval[] {
  if (!Array.isArray(intervals) || intervals.length === 0) return invalid(`${label} needs at least one date window.`);
  if (intervals.length > MAX_ITEMS) return invalid(`${label} has too many windows.`);
  const parsed = intervals.map((interval) => {
    const start = parseTimestamp(interval?.startAt);
    const end = parseTimestamp(interval?.endAt);
    if (start === null || end === null) {
      return invalid(`${label} windows need exact dates and times with a timezone, like 2026-10-16T17:00-04:00.`);
    }
    if (start >= end) return invalid(`${label} windows must end after they start.`);
    return { start, end };
  });
  parsed.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const window of parsed) {
    const last = merged.at(-1);
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }
  return merged.map((w) => ({ startAt: new Date(w.start).toISOString(), endAt: new Date(w.end).toISOString() }));
}

/** Windows that every list has in common and that are at least `minHours` long. */
export function commonWindows(lists: readonly (readonly Interval[])[], minHours = 0): Interval[] {
  if (lists.length === 0) return [];
  let common = normalizeIntervals(lists[0]);
  for (const list of lists.slice(1)) {
    const other = normalizeIntervals(list);
    const next: Interval[] = [];
    for (const a of common) {
      for (const b of other) {
        const start = Math.max(Date.parse(a.startAt), Date.parse(b.startAt));
        const end = Math.min(Date.parse(a.endAt), Date.parse(b.endAt));
        if (start < end) next.push({ startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() });
      }
    }
    if (next.length === 0) return [];
    common = normalizeIntervals(next);
  }
  return common.filter((w) => Date.parse(w.endAt) - Date.parse(w.startAt) >= minHours * MS_PER_HOUR);
}

/** Hours a trip of this many nights needs end to end. */
export function hoursNeeded(nights: number): number {
  return nights * HOURS_PER_NIGHT;
}

// ---- validation and normalization -------------------------------------------------------------------

function normalizeValue<F extends ConstraintField>(field: F, value: ConstraintValues[F]): ConstraintValues[F] {
  const v = value as ConstraintValues[ConstraintField];
  switch (field) {
    case 'budget': {
      try {
        assertPositiveCents((v as ConstraintValues['budget']).cents, 'budget');
      } catch (error) {
        if (error instanceof MoneyError) return invalid('A budget has to be a positive amount.');
        throw error;
      }
      return { cents: (v as ConstraintValues['budget']).cents } as ConstraintValues[F];
    }
    case 'availability':
      return { intervals: normalizeIntervals((v as ConstraintValues['availability']).intervals) } as ConstraintValues[F];
    case 'preferences': {
      const items = cleanList((v as ConstraintValues['preferences']).items, 'preferences', false);
      if (items.includes(NO_PREFERENCE) && items.length > 1) {
        return invalid(`"${NO_PREFERENCE}" can't be combined with other preferences.`);
      }
      return { items } as ConstraintValues[F];
    }
    case 'must_dos':
      return { items: cleanList((v as ConstraintValues['must_dos']).items, 'must-dos', true) } as ConstraintValues[F];
    case 'transport': {
      const t = v as ConstraintValues['transport'];
      if (t.mode !== 'car') return invalid('This planner only handles road trips by car for now.');
      if (typeof t.vehicleAvailable !== 'boolean') return invalid('Does the group have a car? Please say yes or no.');
      return { mode: 'car', vehicleAvailable: t.vehicleAvailable } as ConstraintValues[F];
    }
    case 'region': {
      const r = v as ConstraintValues['region'];
      const out: ConstraintValues['region'] = {};
      if (r.destination !== undefined) out.destination = cleanText(r.destination, 'destination');
      if (r.searchRegion !== undefined) out.searchRegion = cleanText(r.searchRegion, 'region');
      if (r.maxTravelMinutes !== undefined) {
        if (!Number.isInteger(r.maxTravelMinutes) || r.maxTravelMinutes < 1 || r.maxTravelMinutes > MAX_TRAVEL_MINUTES) {
          return invalid('The most travel time has to be a whole number of minutes.');
        }
        out.maxTravelMinutes = r.maxTravelMinutes;
      }
      if (Object.keys(out).length === 0) return invalid('Name a destination, a region, or the most travel time you will accept.');
      return out as ConstraintValues[F];
    }
    case 'duration': {
      const nights = (v as ConstraintValues['duration']).nights;
      if (!Number.isInteger(nights) || nights < 1 || nights > MAX_NIGHTS) {
        return invalid(`The trip has to be between 1 and ${MAX_NIGHTS} nights.`);
      }
      return { nights } as ConstraintValues[F];
    }
    case 'origin':
      return { city: cleanText((v as ConstraintValues['origin']).city, 'departure city') } as ConstraintValues[F];
    default:
      return invalid('I don\'t recognize that kind of constraint.');
  }
}

/**
 * Check an update against the roster and the rules, and return it cleaned up. Throws `ConstraintError`.
 * Nobody may change another member's limits, and unknown or non-consenting people change nothing.
 */
export function validateUpdate(state: TripState, actorId: MemberId, update: ConstraintUpdate): ConstraintUpdate {
  const actor = state.roster.find((m) => m.memberId === actorId);
  if (!actor) throw new ConstraintError('UNKNOWN_MEMBER', "I don't know who that is, so I can't change the plan.");
  if (!actor.consented) {
    throw new ConstraintError('UNKNOWN_MEMBER', 'I can only use trip details from people who have agreed to plan with me.');
  }
  if (update.memberId !== actorId) {
    return invalid(`You can only change your own ${update.field === 'budget' ? 'budget' : 'details'}.`);
  }
  if (typeof update.sourceMessageId !== 'string' || update.sourceMessageId === '') {
    return invalid('Every update has to point at the message it came from.');
  }
  if (update.certainty !== 'tentative' && update.certainty !== 'confirmed') return invalid('Is that firm or just an idea?');
  if (![...MEMBER_FIELDS, ...GROUP_FIELDS].includes(update.field)) return invalid("I don't recognize that kind of constraint.");

  const value = normalizeValue(update.field, update.value as never);
  return { ...update, value } as ConstraintUpdate;
}

// ---- recording ---------------------------------------------------------------------------------------

/** Append a validated update with its provenance. Returns a new state; the input is not modified. */
export function recordConstraint(state: TripState, update: ConstraintUpdate, recordedAt: string): TripState {
  const record = { ...update, recordedAt, revision: state.revision } as ConstraintRecord;
  if ((MEMBER_FIELDS as readonly string[]).includes(update.field)) {
    return {
      ...state,
      memberConstraints: {
        ...state.memberConstraints,
        [update.memberId]: [...(state.memberConstraints[update.memberId] ?? []), record],
      },
    };
  }
  return { ...state, groupConstraints: [...state.groupConstraints, record] };
}

// ---- reading -----------------------------------------------------------------------------------------

type RecordOf<F extends ConstraintField> = Extract<ConstraintRecord, { field: F }>;

function recordsFor<F extends ConstraintField>(state: TripState, memberId: MemberId, field: F): RecordOf<F>[] {
  const source = (MEMBER_FIELDS as readonly string[]).includes(field)
    ? (state.memberConstraints[memberId] ?? [])
    : state.groupConstraints.filter((r) => r.memberId === memberId);
  return source.filter((r): r is RecordOf<F> => r.field === field);
}

/** A member's latest confirmed statement about a field. Tentative statements never count as effective. */
export function latestConfirmed<F extends ConstraintField>(state: TripState, memberId: MemberId, field: F): RecordOf<F> | undefined {
  return recordsFor(state, memberId, field).filter((r) => r.certainty === 'confirmed').at(-1);
}

/**
 * True when a member said something tentative about a hard limit after their last confirmed statement. The
 * plan keeps using the confirmed value, but readiness asks rather than silently ignoring a possible change.
 */
export function hasUnconfirmedChange(state: TripState, memberId: MemberId, field: 'budget' | 'availability' | 'must_dos'): boolean {
  const records = recordsFor(state, memberId, field);
  const lastConfirmed = records.map((r) => r.certainty).lastIndexOf('confirmed');
  return records.slice(lastConfirmed + 1).some((r) => r.certainty === 'tentative');
}

export function effectiveBudget(state: TripState, memberId: MemberId): number | undefined {
  return latestConfirmed(state, memberId, 'budget')?.value.cents;
}

export function effectiveAvailability(state: TripState, memberId: MemberId): Interval[] | undefined {
  return latestConfirmed(state, memberId, 'availability')?.value.intervals;
}

/** Whether a member has said anything about their preferences, firm or not ("no preference" counts). */
export function statedPreferences(state: TripState, memberId: MemberId): string[] | undefined {
  const records = recordsFor(state, memberId, 'preferences');
  if (records.length === 0) return undefined;
  // Preferences are soft and people add to them ("also historical places"), so they accumulate. Saying
  // "no preference" starts over, and so does the first preference after it.
  let stated = new Set<string>();
  for (const record of records) {
    const items = record.value.items;
    if (items.includes(NO_PREFERENCE)) stated = new Set(items);
    else {
      if (stated.has(NO_PREFERENCE)) stated = new Set();
      for (const item of items) stated.add(item);
    }
  }
  return [...stated].sort();
}

/** Hard must-dos, accessibility and dietary needs: only confirmed ones are enforced. */
export function effectiveMustDos(state: TripState, memberId: MemberId): string[] {
  return latestConfirmed(state, memberId, 'must_dos')?.value.items ?? [];
}

export type GroupResolution<F extends ConstraintField> =
  | { status: 'unset'; tentativeOnly: boolean }
  | { status: 'agreed'; value: ConstraintValues[F]; authors: MemberId[] }
  | { status: 'conflict'; positions: Array<{ memberId: MemberId; value: ConstraintValues[F] }> };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(typeof value === 'string' ? value.toLowerCase() : value);
}

/**
 * A group-level field's value. Each participant's latest confirmed statement is their position; if all
 * positions agree the value is effective, and if they differ it is a conflict until someone restates it.
 * Silence is not disagreement, and tentative statements do not count.
 */
export function resolveGroupField<F extends 'transport' | 'region' | 'duration' | 'origin'>(
  state: TripState,
  field: F,
): GroupResolution<F> {
  const positions: Array<{ memberId: MemberId; value: ConstraintValues[F] }> = [];
  let sawTentative = false;
  for (const memberId of participantIds(state)) {
    const confirmed = latestConfirmed(state, memberId, field);
    if (confirmed) positions.push({ memberId, value: (confirmed as { value: ConstraintValues[F] }).value });
    else if (recordsFor(state, memberId, field).length > 0) sawTentative = true;
  }
  if (positions.length === 0) return { status: 'unset', tentativeOnly: sawTentative };
  const distinct = new Set(positions.map((p) => canonical(p.value)));
  if (distinct.size === 1) {
    return { status: 'agreed', value: positions[0].value, authors: positions.map((p) => p.memberId) };
  }
  return { status: 'conflict', positions };
}
