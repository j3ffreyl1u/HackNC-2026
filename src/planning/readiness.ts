import {
  commonWindows,
  effectiveAvailability,
  effectiveBudget,
  hasUnconfirmedChange,
  hoursNeeded,
  resolveGroupField,
  statedPreferences,
} from './constraints.js';
import { formatUsd } from './money.js';
import { BUDGET_QUESTION, fieldForKey, selectQuestions, type QuestionCandidate } from './questions.js';
import { displayName, participants, participantIds } from './state.js';
import type { ConstraintValues, ReadinessQuestion, ReadinessResult, TripState } from './types.js';

const MIN_PARTICIPANTS = 2;

export interface ReadinessOptions {
  /** The current time, used only to avoid repeating a recent unanswered question. */
  now?: string;
}

function names(state: TripState, ids: readonly string[]): string {
  const list = ids.map((id) => displayName(state, id));
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

const nightsText = (n: number) => `${n} night${n === 1 ? '' : 's'}`;

interface Evaluation {
  missing: string[];
  conflicts: string[];
  candidates: QuestionCandidate[];
}

/**
 * What stands between this trip and research, derived only from recorded, attributed constraints. Never from
 * how many messages were sent or how confident a model sounded.
 */
function evaluate(state: TripState): Evaluation {
  const missing: string[] = [];
  const conflicts: string[] = [];
  const candidates: QuestionCandidate[] = [];
  const field = (key: string) => {
    const f = fieldForKey(key);
    return f === undefined ? {} : { field: f };
  };
  const group = (topic: QuestionCandidate['topic'], key: string, text: string) =>
    candidates.push({ topic, question: { audience: { kind: 'group' }, text, key, ...field(key) } });
  const privately = (topic: QuestionCandidate['topic'], memberId: string, key: string, text: string) =>
    candidates.push({ topic, question: { audience: { kind: 'private', memberId }, text, key, ...field(key) } });

  // -- people: a confirmed roster of at least two who have agreed to plan with the bot
  const waiting = state.roster.filter((m) => !m.consented).map((m) => m.memberId);
  for (const id of waiting) missing.push(`consent:${id}`);
  if (waiting.length > 0) {
    group('people', 'consent', `I'm still waiting for ${names(state, waiting)} to agree to plan the trip with me before I use their details.`);
  }
  if (participants(state).length < MIN_PARTICIPANTS) {
    missing.push('roster');
    if (waiting.length === 0) group('people', 'roster', 'Who is coming on the trip? I need at least two people to plan with.');
  }

  const ids = participantIds(state);

  // -- basics: departure city, trip length, destination or search bound, and a car
  const origin = resolveGroupField(state, 'origin');
  if (origin.status === 'unset') {
    missing.push('origin');
    group('basics', 'origin', origin.tentativeOnly ? 'Just to confirm: is that where you will all be leaving from?' : 'Where will you be leaving from?');
  } else if (origin.status === 'conflict') {
    conflicts.push('origin');
    const options = origin.positions.map((p) => `${(p.value as ConstraintValues['origin']).city} (${displayName(state, p.memberId)})`);
    group('basics', 'conflict:origin', `I have different departure cities: ${options.join(' or ')}. Which one is right?`);
  }

  const duration = resolveGroupField(state, 'duration');
  if (duration.status === 'unset') {
    missing.push('duration');
    group('basics', 'duration', duration.tentativeOnly ? 'Just to confirm: how many nights is the trip?' : 'How many nights should the trip be?');
  } else if (duration.status === 'conflict') {
    conflicts.push('duration');
    const options = duration.positions.map((p) => `${nightsText((p.value as ConstraintValues['duration']).nights)} (${displayName(state, p.memberId)})`);
    group('basics', 'conflict:duration', `I have different trip lengths: ${options.join(' or ')}. Which one is right?`);
  }

  const region = resolveGroupField(state, 'region');
  if (region.status === 'unset') {
    missing.push('region');
    group('basics', 'region', 'Do you have a destination in mind, or how long are you willing to drive?');
  } else if (region.status === 'conflict') {
    conflicts.push('region');
    group('basics', 'conflict:region', 'I have different ideas for where to go or how far to drive. Which one should I plan around?');
  }

  const transport = resolveGroupField(state, 'transport');
  if (transport.status === 'unset') {
    missing.push('transport');
    group('basics', 'transport', 'Does anyone have a car for the trip?');
  } else if (transport.status === 'conflict') {
    conflicts.push('transport');
    group('basics', 'conflict:transport', 'I have conflicting answers about whether you have a car. Does anyone have one for the trip?');
  } else if (!(transport.value as ConstraintValues['transport']).vehicleAvailable) {
    missing.push('vehicle');
    group('basics', 'vehicle', "I can only plan road trips for now, so I need a car. Could anyone drive or borrow one?");
  }

  // -- dates: every participant's usable windows, and one window everybody shares that fits the trip
  const missingDates = ids.filter((id) => effectiveAvailability(state, id) === undefined);
  for (const id of missingDates) missing.push(`availability:${id}`);
  if (missingDates.length > 0) {
    group('dates', 'availability', `${names(state, missingDates)}, which dates could you ${missingDates.length > 1 ? 'each ' : ''}do for the trip?`);
  }
  for (const id of ids) {
    if (effectiveAvailability(state, id) !== undefined && hasUnconfirmedChange(state, id, 'availability')) {
      conflicts.push(`availability_unconfirmed:${id}`);
      privately('dates', id, `availability_unconfirmed:${id}`, 'You mentioned some different dates. Are your usable dates still the ones you gave before, or have they changed?');
    }
  }
  if (missingDates.length === 0 && ids.length >= MIN_PARTICIPANTS && duration.status === 'agreed') {
    const nights = (duration.value as ConstraintValues['duration']).nights;
    const windows = commonWindows(
      ids.map((id) => effectiveAvailability(state, id) ?? []),
      hoursNeeded(nights),
    );
    if (windows.length === 0) {
      conflicts.push('dates');
      group(
        'dates',
        'conflict:dates',
        `I can't find a ${nightsText(nights)} window that works for everyone. Could you each double-check your dates and tell me which of the dates you gave is right?`,
      );
    }
  }

  // -- money: every participant's firm all-in maximum
  for (const id of ids) {
    const cents = effectiveBudget(state, id);
    if (cents === undefined) {
      missing.push(`budget:${id}`);
      privately('money', id, `budget:${id}`, BUDGET_QUESTION);
    } else if (hasUnconfirmedChange(state, id, 'budget')) {
      conflicts.push(`budget_unconfirmed:${id}`);
      privately(
        'money',
        id,
        `budget_unconfirmed:${id}`,
        `Earlier you gave ${formatUsd(cents)} as your maximum total for the trip, then mentioned a different amount. Which is your maximum, including food and travel?`,
      );
    }
  }

  // -- hard must-dos that were only floated are not silently dropped
  for (const id of ids) {
    if (hasUnconfirmedChange(state, id, 'must_dos')) {
      conflicts.push(`must_dos_unconfirmed:${id}`);
      privately('preferences', id, `must_dos_unconfirmed:${id}`, 'You mentioned something that sounds like a must-have. Is it a firm requirement for the trip?');
    }
  }

  // -- preferences: a stated list, or an explicit "no preference"
  const quiet = ids.filter((id) => statedPreferences(state, id) === undefined);
  for (const id of quiet) missing.push(`preferences:${id}`);
  if (quiet.length > 0) {
    group('preferences', 'preferences', `${names(state, quiet)}, what would you like out of this trip? "No preference" is a fine answer.`);
  }

  return { missing, conflicts, candidates };
}

/**
 * Is the trip ready to research? Returns exactly what is missing or contradictory and at most two related
 * questions to ask now. Optional details are never confused with required ones.
 */
export function checkReadiness(state: TripState, options: ReadinessOptions = {}): ReadinessResult {
  const { missing, conflicts, candidates } = evaluate(state);
  const questions: ReadinessQuestion[] = selectQuestions(state, candidates, options.now);
  return { ready: missing.length === 0 && conflicts.length === 0, missing, conflicts, questions };
}

/** The keys of every question that is still open, used to forget answered ones. */
export function openQuestionKeys(state: TripState): Set<string> {
  return new Set(evaluate(state).candidates.map((c) => c.question.key));
}
