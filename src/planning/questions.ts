import { participantIds } from './state.js';
import type { ConstraintField, PendingQuestion, ReadinessQuestion, TripState } from './types.js';

/** The exact words for a missing budget. Asked privately, since a limit may be sensitive. */
export const BUDGET_QUESTION = "What's your maximum total for this trip, including food and travel?";

/** Questions go out one at a time per person; this is kept for callers that import it. */
export const MAX_QUESTIONS_PER_TURN = 1;

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
 * Pick what to ask now, ONE question at a time per person, so nobody is flooded.
 *  - A question that is asked and still unanswered (within the cooldown) blocks further questions to whoever it
 *    reached: a shared question reaches everyone, a private one only its person.
 *  - Candidates are taken in topic order. A shared question needs everyone free and then takes everyone; a private
 *    question needs only its own person free. Nobody gets more than one per turn.
 * So a second person starting the conversation while a shared question is open gets no new questions at all, and
 * answers arrive one topic after another instead of five at once.
 */
export function selectQuestions(state: TripState, candidates: readonly QuestionCandidate[], now?: string, actorId?: string): ReadinessQuestion[] {
  if (actorId !== undefined) return delegateQuestions(state, candidates, now, actorId);
  const everyone = participantIds(state);
  const open = state.pendingQuestions.filter((q) => now === undefined || Date.parse(now) - Date.parse(q.askedAt) < QUESTION_COOLDOWN_MS);
  const sharedOpen = open.some((q) => q.audience.kind === 'group');
  const busy = new Set<string>(sharedOpen ? everyone : open.flatMap((q) => (q.audience.kind === 'private' ? [q.audience.memberId] : [])));
  const taken = new Set<string>();
  const asking: ReadinessQuestion[] = [];
  const askable = candidates.filter((c) => !recentlyAsked(state, c.question.key, now));
  for (const topic of TOPIC_ORDER) {
    for (const { question } of askable.filter((c) => c.topic === topic)) {
      const audience = question.audience;
      if (audience.kind === 'group') {
        if (everyone.length === 0 || everyone.some((id) => busy.has(id) || taken.has(id))) continue;
        everyone.forEach((id) => taken.add(id));
      } else {
        if (busy.has(audience.memberId) || taken.has(audience.memberId)) continue;
        taken.add(audience.memberId);
      }
      asking.push(question);
    }
  }
  return asking;
}

/**
 * When two people plan at the same time the work is split, not duplicated. The person talking is asked the next shared
 * question (one shared question is open at a time, held by whoever got it), and everyone else is free to be asked their
 * OWN things (dates, budget, tastes) in the meantime. Nobody gets more than one question per turn.
 */
function delegateQuestions(state: TripState, candidates: readonly QuestionCandidate[], now: string | undefined, actorId: string): ReadinessQuestion[] {
  const open = state.pendingQuestions.filter((q) => now === undefined || Date.parse(now) - Date.parse(q.askedAt) < QUESTION_COOLDOWN_MS);
  const sharedOpen = open.some((q) => q.audience.kind === 'group');
  const busy = new Set<string>(open.flatMap((q) => (q.audience.kind === 'private' ? [q.audience.memberId] : [])));
  const taken = new Set<string>();
  const engaged = (id: string) => (state.memberConstraints[id]?.length ?? 0) > 0 || state.groupConstraints.some((r) => r.memberId === id);
  let sharedTaken = false;
  const asking: ReadinessQuestion[] = [];
  const askable = candidates.filter((c) => !recentlyAsked(state, c.question.key, now));
  for (const topic of TOPIC_ORDER) {
    for (const { question } of askable.filter((c) => c.topic === topic)) {
      const audience = question.audience;
      if (audience.kind === 'group') {
        if (sharedOpen || sharedTaken || busy.has(actorId) || taken.has(actorId)) continue;
        sharedTaken = true;
        taken.add(actorId);
      } else {
        if (busy.has(audience.memberId) || taken.has(audience.memberId)) continue;
        // Someone who has not joined in yet is only contacted unprompted with a message that explains itself.
        if (audience.memberId !== actorId && !engaged(audience.memberId) && !question.key.startsWith('confirm_basics:')) continue;
        taken.add(audience.memberId);
      }
      asking.push(question);
    }
  }
  return asking;
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
