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
  /** Count a missing sign-off on the shared basics as not ready. Off by default: an explicit request for options goes ahead. */
  requireSignOff?: boolean;
  /** Who is talking right now. Questions are then divided between people instead of all going to everyone. */
  actorId?: string;
}

function names(state: TripState, ids: readonly string[]): string {
  const list = ids.map((id) => displayName(state, id));
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov 14-17, Dec 20-31". An end that falls exactly on midnight is the day before; windows are shown in the trip's local time. */
function formatWindows(windows: readonly { startAt: string; endAt: string }[]): string {
  const local = (ms: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value]));
    return { month: Number(p.month), day: Number(p.day), hour: Number(p.hour) };
  };
  return windows.map((w) => {
    const start = local(Date.parse(w.startAt));
    const endMs = Date.parse(w.endAt);
    const end = local(local(endMs).hour === 0 ? endMs - 3_600_000 : endMs);
    const s = `${MONTHS[start.month - 1]} ${start.day}`;
    return start.month === end.month && start.day === end.day ? s : start.month === end.month ? `${s}-${end.day}` : `${s}-${MONTHS[end.month - 1]} ${end.day}`;
  }).join(', ') || 'never';
}

/** "leaving from Chapel Hill for 2 nights, going to Washington DC": the shared basics in one casual phrase. */
function describeBasics(origin: ConstraintValues['origin'], duration: ConstraintValues['duration'], region: ConstraintValues['region']): string {
  const place = region.destination !== undefined ? `going to ${region.destination}`
    : region.maxTravelMinutes !== undefined && region.maxTravelMinutes >= 1440 ? 'open to any driving distance'
    : region.searchRegion !== undefined ? `looking around ${region.searchRegion}`
    : region.maxTravelMinutes !== undefined ? `staying within about ${Math.round(region.maxTravelMinutes / 60)} hours of driving` : 'a place to be decided';
  return `leaving from ${origin.city} for ${nightsText(duration.nights)}, ${place}`;
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
    if (waiting.length === 0) group('people', 'roster', "I need at least two people to plan with. Ask whoever's missing to text me, and I'll get them added.");
  }

  const ids = participantIds(state);

  // -- basics: departure city, trip length, destination or search bound, and a car
  const origin = resolveGroupField(state, 'origin');
  if (origin.status === 'unset') {
    missing.push('origin');
    group('basics', 'origin', origin.tentativeOnly ? 'Just to confirm: is that where you will all be leaving from?' : 'Where are you all leaving from?');
  } else if (origin.status === 'conflict') {
    conflicts.push('origin');
    const options = origin.positions.map((p) => `${(p.value as ConstraintValues['origin']).city} (${displayName(state, p.memberId)})`);
    group('basics', 'conflict:origin', `I have different departure cities: ${options.join(' or ')}. Which one is right?`);
  }

  const duration = resolveGroupField(state, 'duration');
  if (duration.status === 'unset') {
    missing.push('duration');
    group('basics', 'duration', duration.tentativeOnly ? 'Just to confirm: how many nights is the trip?' : 'How many nights are you thinking?');
  } else if (duration.status === 'conflict') {
    conflicts.push('duration');
    const options = duration.positions.map((p) => `${nightsText((p.value as ConstraintValues['duration']).nights)} (${displayName(state, p.memberId)})`);
    group('basics', 'conflict:duration', `I have different trip lengths: ${options.join(' or ')}. Which one is right?`);
  }

  const region = resolveGroupField(state, 'region');
  if (region.status === 'unset') {
    missing.push('region');
    group('basics', 'region', 'Got a place in mind, or how far are you up for driving?');
  } else if (region.status === 'conflict') {
    conflicts.push('region');
    group('basics', 'conflict:region', 'I have different ideas for where to go or how far to drive. Which one should I plan around?');
  }

  const transport = resolveGroupField(state, 'transport');
  if (transport.status === 'unset') {
    missing.push('transport');
    group('basics', 'transport', 'Does anyone have a car we can take?');
  } else if (transport.status === 'conflict') {
    conflicts.push('transport');
    group('basics', 'conflict:transport', 'I have conflicting answers about whether you have a car. Does anyone have one for the trip?');
  } else if (!(transport.value as ConstraintValues['transport']).vehicleAvailable) {
    missing.push('vehicle');
    group('basics', 'vehicle', "I can only plan road trips for now, so I need a car. Could anyone drive or borrow one?");
  }

  // -- everyone gets a say in the shared basics: anyone who has not weighed in is asked whether the plan so far works
  if (origin.status === 'agreed' && duration.status === 'agreed' && region.status === 'agreed' && transport.status === 'agreed' && (transport.value as ConstraintValues['transport']).vehicleAvailable) {
    const authors = new Set([...origin.authors, ...duration.authors, ...region.authors, ...transport.authors]);
    for (const id of ids.filter((x) => !authors.has(x))) {
      missing.push(`confirm_basics:${id}`);
      privately('basics', id, `confirm_basics:${id}`, `${names(state, [...authors])} suggested ${describeBasics(origin.value, duration.value, region.value)}, and someone has a car. Does that work for you, or would you change anything?`);
    }
  }

  // -- dates: every participant's usable windows, and one window everybody shares that fits the trip
  const missingDates = ids.filter((id) => effectiveAvailability(state, id) === undefined);
  for (const id of missingDates) missing.push(`availability:${id}`);
  // Each person is asked about their own dates, privately, so nobody else's phone gets the question.
  for (const id of missingDates) privately('dates', id, `availability:${id}`, 'Which dates could you do for the trip?');
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
      const freeWhen = ids.map((id) => `${displayName(state, id)} is free ${formatWindows(effectiveAvailability(state, id) ?? [])}`);
      group(
        'dates',
        'conflict:dates',
        `${freeWhen.join(' and ')}, so there's no ${nightsText(nights)} stretch that works for everyone. Could either of you open up other dates?`,
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
  for (const id of quiet) privately('preferences', id, `preferences:${id}`, 'What would you like out of this trip? "No preference" is a fine answer.');

  return { missing, conflicts, candidates };
}

/**
 * Is the trip ready to research? Returns exactly what is missing or contradictory and at most two related
 * questions to ask now. Optional details are never confused with required ones.
 */
export function checkReadiness(state: TripState, options: ReadinessOptions = {}): ReadinessResult {
  const evaluated = evaluate(state);
  const { conflicts, candidates } = evaluated;
  const missing = options.requireSignOff ? evaluated.missing : evaluated.missing.filter((m) => !m.startsWith('confirm_basics:'));
  const questions: ReadinessQuestion[] = selectQuestions(state, candidates, options.now, options.actorId);
  return { ready: missing.length === 0 && conflicts.length === 0, missing, conflicts, questions };
}

/** The keys of every question that is still open, used to forget answered ones. */
export function openQuestionKeys(state: TripState): Set<string> {
  return new Set(evaluate(state).candidates.map((c) => c.question.key));
}

/**
 * A plain sentence on what the plan is still waiting for, with no values in it, only who and what. Used when
 * every question was already asked recently, so a request for options is never answered with silence.
 */
export function describeGaps(state: TripState, result: Pick<ReadinessResult, 'missing' | 'conflicts'>, viewerId?: string): string {
  const items: string[] = [];
  const perPerson = (key: string, label: (name: string) => string) => {
    const ids = result.missing.filter((m) => m.startsWith(`${key}:`)).map((m) => m.slice(key.length + 1));
    // When nobody has answered yet, "everyone's budget" reads better than a name for each person.
    if (ids.length > 1 && ids.length === participantIds(state).length) return [label('everyone')];
    // The person reading it hears "your" for their own gaps instead of their name.
    return ids.map((id) => (id === viewerId ? label('your') : label(displayName(state, id))));
  };
  const consent = result.missing.filter((m) => m.startsWith('consent:')).map((m) => m.slice('consent:'.length));
  if (consent.length > 0) items.push(`${names(state, consent)} to agree to plan with me`);
  if (result.missing.includes('roster')) items.push('who else is coming');
  if (result.missing.includes('origin')) items.push("where you're leaving from");
  if (result.missing.includes('duration')) items.push('how many nights');
  if (result.missing.includes('region')) items.push('where you want to go');
  if (result.missing.includes('transport') || result.missing.includes('vehicle')) items.push('whether someone has a car');
  const unconfirmed = result.missing.filter((m) => m.startsWith('confirm_basics:')).map((m) => m.slice('confirm_basics:'.length));
  if (unconfirmed.length > 0) items.push(`${names(state, unconfirmed)} to say whether the plan so far works`);
  items.push(...perPerson('availability', (n) => (n === 'your' ? 'your dates' : `${n}'s dates`)));
  items.push(...perPerson('budget', (n) => (n === 'your' ? 'your budget' : `${n}'s budget`)));
  items.push(...perPerson('preferences', (n) => (n === 'your' ? 'your preferences' : `${n}'s preferences`)));
  const parts = items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');
  const tail = result.conflicts.length > 0 ? 'Some answers also don\'t match yet, so I need those sorted out.' : '';
  if (parts === '') return tail === '' ? "I'm not ready to plan yet." : `I'm not ready to plan yet. ${tail}`;
  // Nothing has been told to the assistant yet: "still waiting" would be wrong, so say what the plan needs instead.
  const fresh = Object.values(state.memberConstraints).every((list) => list.length === 0) && state.groupConstraints.length === 0;
  // Nothing answered yet: no checklist, just the question that is already open.
  if (fresh) return [...state.pendingQuestions].sort((a, b) => b.askedAt.localeCompare(a.askedAt))[0]?.text ?? "Happy to help! Where are you all leaving from?";
  return `I'm still waiting on ${parts}.${tail === '' ? '' : ` ${tail}`}`;
}
