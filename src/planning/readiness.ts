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
import { Q } from './wording.js';
import { BUDGET_QUESTION, TOPIC_ORDER, fieldForKey, selectQuestions, type QuestionCandidate } from './questions.js';
import { displayName, participants, participantIds } from './state.js';
import type { ConstraintValues, ReadinessQuestion, ReadinessResult, TripState } from './types.js';

const MIN_PARTICIPANTS = 2;

/** Getting there is settled: flying needs no car, driving needs someone's car. */
const travelSorted = (t: ConstraintValues['transport']): boolean => t.mode === 'plane' || t.vehicleAvailable === true;

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


/** " Jeffrey is free Nov 14-17 and is into hiking.": what the people who started the plan have shared (never a budget). */
function authorsSaid(state: TripState, ids: readonly string[]): string {
  const parts = ids.map((id) => {
    const windows = effectiveAvailability(state, id);
    const prefs = statedPreferences(state, id)?.filter((v) => !/\$|\d|\b(?:budget|max(?:imum)?)\b/i.test(v));   // never repeat anything that mentions money
    const bits: string[] = [];
    if (windows && windows.length > 0) bits.push(`is free ${formatWindows(windows)}`);
    if (prefs && prefs.length > 0 && !prefs.includes('no preference')) bits.push(`is into ${prefs.join(' and ')}`);
    return bits.length > 0 ? `${displayName(state, id)} ${bits.join(' and ')}.` : '';
  }).filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/** "leaving from Chapel Hill for 2 nights, going to Washington DC": the shared basics in one casual phrase. */
function describeBasics(origin: ConstraintValues['origin'], duration: ConstraintValues['duration'], region: ConstraintValues['region']): string {
  const place = region.destination !== undefined ? `going to ${titleCase(region.destination)}`
    : region.maxTravelMinutes !== undefined && region.maxTravelMinutes >= 1440 ? 'open to any driving distance'
    : region.searchRegion !== undefined ? `looking around ${titleCase(region.searchRegion)}`
    : region.maxTravelMinutes !== undefined ? `staying within about ${Math.round(region.maxTravelMinutes / 60)} hours of driving` : 'a place to be decided';
  return `leaving from ${titleCase(origin.city)} for ${nightsText(duration.nights)}, ${place}`;
}

/** "chapel hill" -> "Chapel Hill". Only touches words typed in lower case, so "NC" and "DC" stay as written. */
function titleCase(text: string): string {
  return text.replace(/\b([a-z])([a-z.']*)/g, (word, first: string, rest: string) => (['of', 'the', 'and', 'in', 'on', 'by'].includes(word) ? word : first.toUpperCase() + rest));
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
    group('basics', 'origin', origin.tentativeOnly ? Q.originConfirm : Q.origin);
  } else if (origin.status === 'conflict') {
    conflicts.push('origin');
    const options = origin.positions.map((p) => `${displayName(state, p.memberId)} is leaving from ${(p.value as ConstraintValues['origin']).city}`);
    group('basics', 'conflict:origin', `${options.join(' and ')}. Which city should I plan the trip from?`);
  }

  const duration = resolveGroupField(state, 'duration');
  if (duration.status === 'unset') {
    missing.push('duration');
    group('basics', 'duration', duration.tentativeOnly ? Q.durationConfirm : Q.duration);
  } else if (duration.status === 'conflict') {
    conflicts.push('duration');
    const options = duration.positions.map((p) => `${displayName(state, p.memberId)} is thinking ${nightsText((p.value as ConstraintValues['duration']).nights)}`);
    group('basics', 'conflict:duration', `${options.join(' and ')}. Which should we go with?`);
  }

  const region = resolveGroupField(state, 'region');
  if (region.status === 'unset') {
    missing.push('region');
    group('basics', 'region', Q.region);
  } else if (region.status === 'conflict') {
    conflicts.push('region');
    const options = region.positions.map((p) => {
      const v = p.value as ConstraintValues['region'];
      const label = v.destination ?? v.searchRegion ?? (v.maxTravelMinutes !== undefined ? `within about ${Math.round(v.maxTravelMinutes / 60)} hours of driving` : 'somewhere else');
      return `${displayName(state, p.memberId)} is thinking ${label}`;
    });
    group('basics', 'conflict:region', `${options.join(' and ')}. Which sounds better?`);
  }

  const transport = resolveGroupField(state, 'transport');
  if (transport.status === 'unset') {
    missing.push('transport');
    group('basics', 'transport', Q.transport);
  } else if (transport.status === 'conflict') {
    conflicts.push('transport');
    group('basics', 'conflict:transport', "Some of you said driving and some said flying, so I have conflicting answers. Are you driving or flying?");
  } else if (!travelSorted(transport.value as ConstraintValues['transport'])) {
    missing.push('vehicle');
    group('basics', 'vehicle', Q.vehicle);
  }

  // -- everyone gets a say in the shared basics: anyone who has not weighed in is asked whether the plan so far works
  if (origin.status === 'agreed' && duration.status === 'agreed' && region.status === 'agreed' && transport.status === 'agreed' && travelSorted(transport.value as ConstraintValues['transport'])) {
    const authors = new Set([...origin.authors, ...duration.authors, ...region.authors, ...transport.authors]);
    for (const id of ids.filter((x) => !authors.has(x))) {
      missing.push(`confirm_basics:${id}`);
      privately('basics', id, `confirm_basics:${id}`, `Hey ${displayName(state, id)}! ${names(state, [...authors])} started planning a trip with you. So far the idea is ${describeBasics(origin.value, duration.value, region.value)}, ${(transport.value as ConstraintValues['transport']).mode === 'plane' ? 'flying' : 'with a car'}.${authorsSaid(state, [...authors])} I share who's free when with the group to find a weekend; budgets stay private. Does that work for you, or would you change anything?`);
    }
  }

  // -- dates: every participant's usable windows, and one window everybody shares that fits the trip
  const missingDates = ids.filter((id) => effectiveAvailability(state, id) === undefined);
  for (const id of missingDates) missing.push(`availability:${id}`);
  // Each person is asked about their own dates, privately, so nobody else's phone gets the question.
  for (const id of missingDates) privately('dates', id, `availability:${id}`, Q.dates);
  for (const id of ids) {
    if (effectiveAvailability(state, id) !== undefined && hasUnconfirmedChange(state, id, 'availability')) {
      conflicts.push(`availability_unconfirmed:${id}`);
      privately('dates', id, `availability_unconfirmed:${id}`, Q.datesChanged);
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
      // With two people the organizer picks who has more room and asks them, by name, for something specific.
      const room = (id: string) => (effectiveAvailability(state, id) ?? []).reduce((sum, w) => sum + (Date.parse(w.endAt) - Date.parse(w.startAt)), 0);
      const [first, second] = ids;
      const flexer = ids.length === 2 && room(first!) !== room(second!) ? (room(first!) > room(second!) ? first! : second!) : undefined;
      const other = flexer === undefined ? undefined : flexer === first ? second! : first!;
      group(
        'dates',
        'conflict:dates',
        flexer !== undefined && other !== undefined
          ? `${freeWhen.join(' and ')}, so there's no ${nights}-night stretch that works for you both. ${displayName(state, flexer)}, since you've got more room, any chance you could do ${formatWindows(effectiveAvailability(state, other) ?? [])}?`
          : `${freeWhen.join(' and ')}, so there's no ${nights}-night stretch that works for everyone. Could someone open up other dates?`,
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
      privately('preferences', id, `must_dos_unconfirmed:${id}`, Q.mustHaveConfirm);
    }
  }

  // -- preferences: a stated list, or an explicit "no preference"
  const quiet = ids.filter((id) => statedPreferences(state, id) === undefined);
  for (const id of quiet) missing.push(`preferences:${id}`);
  for (const id of quiet) privately('preferences', id, `preferences:${id}`, Q.preferences);

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
  if (result.missing.includes('transport')) items.push("whether you're driving or flying");
  if (result.missing.includes('vehicle')) items.push("whose car we're taking");
  const unconfirmed = result.missing.filter((m) => m.startsWith('confirm_basics:')).map((m) => m.slice('confirm_basics:'.length));
  if (unconfirmed.length > 0) items.push(`${names(state, unconfirmed)} to say whether the plan so far works`);
  items.push(...perPerson('availability', (n) => (n === 'your' ? 'your dates' : `${n}'s dates`)));
  items.push(...perPerson('budget', (n) => (n === 'your' ? 'your budget' : `${n}'s budget`)));
  items.push(...perPerson('preferences', (n) => (n === 'your' ? 'your preferences' : `${n}'s preferences`)));
  const parts = items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');
  // Say what is stuck, not just that something is: "Some answers don't match" leaves people guessing.
  const stuck = [...new Set(result.conflicts.map((c) => {
    if (c === 'origin') return "where you're leaving from";
    if (c === 'duration') return 'how many nights';
    if (c === 'region') return 'where to go';
    if (c === 'transport') return "how you're getting there";
    if (c === 'dates') return 'the dates';
    if (c.startsWith('availability_unconfirmed')) return 'dates that still need a firm yes';
    if (c.startsWith('budget_unconfirmed')) return 'a budget that still needs a firm yes';
    if (c.startsWith('must_dos_unconfirmed')) return 'a must-have that still needs a firm yes';
    return 'a detail';
  }))];
  const stuckList = stuck.length > 1 ? `${stuck.slice(0, -1).join(', ')} and ${stuck.at(-1)}` : (stuck[0] ?? '');
  const tail = stuck.length > 0 ? `We also still need to settle ${stuckList}.` : '';
  if (parts === '') return tail === '' ? "I'm not ready to plan yet." : `I'm not ready to plan yet. ${tail}`;
  // Nothing has been told to the assistant yet: "still waiting" would be wrong, so say what the plan needs instead.
  const fresh = Object.values(state.memberConstraints).every((list) => list.length === 0) && state.groupConstraints.length === 0;
  // Nothing answered yet: no checklist, just the question that is already open.
  if (fresh) return [...state.pendingQuestions].sort((a, b) => b.askedAt.localeCompare(a.askedAt))[0]?.text ?? "Happy to help! Where are you all leaving from?";
  const known = settledBasics(state);
  return `${known === '' ? '' : `So far I have ${known}. `}I'm still waiting on ${parts}.${tail === '' ? '' : ` ${tail}`}`;
}

/** The shared basics that are already agreed, in a phrase: "leaving from Chapel Hill, 2 nights, Washington DC and a car". */
function settledBasics(state: TripState): string {
  const origin = resolveGroupField(state, 'origin');
  const duration = resolveGroupField(state, 'duration');
  const region = resolveGroupField(state, 'region');
  const transport = resolveGroupField(state, 'transport');
  const parts: string[] = [];
  if (origin.status === 'agreed') parts.push(`leaving from ${titleCase((origin.value as ConstraintValues['origin']).city)}`);
  if (duration.status === 'agreed') parts.push(nightsText((duration.value as ConstraintValues['duration']).nights));
  if (region.status === 'agreed') {
    const r = region.value as ConstraintValues['region'];
    const place = r.destination ?? r.searchRegion;
    if (place !== undefined) parts.push(titleCase(place));
  }
  if (transport.status === 'agreed' && travelSorted(transport.value as ConstraintValues['transport'])) parts.push((transport.value as ConstraintValues['transport']).mode === 'plane' ? 'flying' : 'a car');
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('');
}

/** What each other person still owes, in a few words, with the one question to ask them next. Used to nudge them. */
export function outstandingForOthers(state: TripState, actorId: string): Array<{ memberId: string; items: string[]; question: ReadinessQuestion }> {
  const { missing, candidates } = evaluate(state);
  const label = (key: string): string | undefined =>
    key.startsWith('availability:') ? 'dates' : key.startsWith('budget:') ? 'budget' : key.startsWith('preferences:') ? 'preferences' : key.startsWith('confirm_basics:') ? 'OK on the plan so far' : undefined;
  const out: Array<{ memberId: string; items: string[]; question: ReadinessQuestion }> = [];
  for (const id of participantIds(state)) {
    if (id === actorId) continue;
    let items = missing.filter((m) => m.endsWith(`:${id}`)).map(label).filter((x): x is string => x !== undefined);
    // The plan sign-off is the question itself, so it is only named when it is the one thing missing.
    if (items.length > 1) items = items.filter((x) => x !== 'OK on the plan so far');
    if (items.length === 0) continue;
    const question = candidates
      .filter((c) => c.question.audience.kind === 'private' && c.question.audience.memberId === id)
      .sort((a, b) => TOPIC_ORDER.indexOf(a.topic) - TOPIC_ORDER.indexOf(b.topic))[0]?.question;
    if (question) out.push({ memberId: id, items, question });
  }
  return out;
}
