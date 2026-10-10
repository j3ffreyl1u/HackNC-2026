import type { ConstraintField, PendingQuestion, ReadinessQuestion, TripState } from './types.js';

/** The exact words for a missing budget. Asked privately, since a limit may be sensitive. */
export const BUDGET_QUESTION = "What's your maximum total for this trip, including food and travel?";

/** At most this many related questions go out in one turn. */
export const MAX_QUESTIONS_PER_TURN = 2;

/** An unanswered question is not asked again automatically until this long has passed. */
export const QUESTION_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * The constraint a question's answer would set, from its key (`budget:alex`, `conflict:origin`, ...). One place
 * maps every key readiness produces, so a reply can be read against the field it answers. Roster and consent
 * questions set no constraint and return `undefined`.
 */
export function fieldForKey(key: string): ConstraintField | undefined {
  const [head, tail] = key.split(':');
  const name = head === 'conflict' ? tail : head;
  switch (name) {
    case 'origin':
    case 'duration':
    case 'region':
    case 'transport':
    case 'preferences':
    case 'budget':
      return name;
    case 'vehicle':
      return 'transport';
    case 'availability':
    case 'dates':
    case 'availability_unconfirmed':
      return 'availability';
    case 'budget_unconfirmed':
      return 'budget';
    case 'must_dos_unconfirmed':
      return 'must_dos';
    default:
      return undefined; // consent, roster
  }
}

/** Questions are grouped by what they are about; one turn asks about one topic only. */
export type QuestionTopic = 'people' | 'basics' | 'dates' | 'money' | 'preferences';

/** Lower numbers are asked first: who is in, then the basics, then dates, then money, then tastes. */
const TOPIC_ORDER: readonly QuestionTopic[] = ['people', 'basics', 'dates', 'money', 'preferences'];

export interface QuestionCandidate {
  topic: QuestionTopic;
  question: ReadinessQuestion;
}

function recentlyAsked(state: TripState, key: string, now: string | undefined): boolean {
  if (now === undefined) return false;
  const nowMs = Date.parse(now);
  return state.pendingQuestions.some((q) => q.key === key && nowMs - Date.parse(q.askedAt) < QUESTION_COOLDOWN_MS);
}

/**
 * Pick what to ask this turn: drop anything asked and still unanswered within the cooldown, take the most
 * important topic that has anything left, and ask at most two questions from it.
 */
export function selectQuestions(state: TripState, candidates: readonly QuestionCandidate[], now?: string): ReadinessQuestion[] {
  const askable = candidates.filter((c) => !recentlyAsked(state, c.question.key, now));
  for (const topic of TOPIC_ORDER) {
    const inTopic = askable.filter((c) => c.topic === topic);
    if (inTopic.length > 0) return inTopic.slice(0, MAX_QUESTIONS_PER_TURN).map((c) => c.question);
  }
  return [];
}

/** Remember that these were asked, so they are not repeated before the cooldown. */
export function recordQuestions(state: TripState, asked: readonly ReadinessQuestion[], now: string): TripState {
  const keys = new Set(asked.map((q) => q.key));
  const kept = state.pendingQuestions.filter((q) => !keys.has(q.key));
  const added: PendingQuestion[] = asked.map((q) => ({
    questionId: `${q.key}@${now}`,
    key: q.key,
    ...(q.field !== undefined ? { field: q.field } : {}),
    audience: q.audience,
    text: q.text,
    askedAt: now,
  }));
  return { ...state, pendingQuestions: [...kept, ...added] };
}

/** Forget questions whose answer has arrived (their key is no longer open). */
export function clearAnsweredQuestions(state: TripState, openKeys: ReadonlySet<string>): TripState {
  const pending = state.pendingQuestions.filter((q) => openKeys.has(q.key));
  return pending.length === state.pendingQuestions.length ? state : { ...state, pendingQuestions: pending };
}
