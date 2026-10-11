import { reprice } from './budget.js';
import { ConstraintError, effectiveAvailability, effectiveBudget, effectiveMustDos, recordConstraint, resolveGroupField, validateUpdate } from './constraints.js';
import { checkReadiness, describeGaps, openQuestionKeys } from './readiness.js';
import { clearAnsweredQuestions, recordQuestions } from './questions.js';
import { displayName, participantIds } from './state.js';
import type {
  ApplyResult,
  ConstraintUpdate,
  MemberId,
  ReadinessQuestion,
  TripCandidate,
  TripCommand,
  TripErrorCode,
  TripReply,
  TripState,
} from './types.js';

export interface ApplyOptions {
  /** The time of the command. Stored with the constraint and used for question cooldowns. Defaults to the clock. */
  now?: string;
  /** Wait for everyone to sign off on the shared basics. Set for the automatic start; an explicit "show us options" does not wait. */
  requireSignOff?: boolean;
}

const GROUP = { kind: 'group' } as const;

function reject(state: TripState, actorId: MemberId, code: TripErrorCode, userMessage: string): ApplyResult {
  return {
    state, // unchanged: a rejected command leaves the trip exactly as it was
    replies: [{ audience: { kind: 'private', memberId: actorId }, text: userMessage }],
    researchRequested: false,
    rejection: { code, userMessage },
  };
}

const toReplies = (questions: readonly ReadinessQuestion[]): TripReply[] =>
  questions.map((q) => ({ audience: q.audience.kind === 'group' ? GROUP : q.audience, text: q.text }));

/** Ask what is still missing, remembering the questions so they are not repeated too soon. */
function askAboutGaps(state: TripState, now: string, actorId?: string): { state: TripState; replies: TripReply[] } {
  const cleared = clearAnsweredQuestions(state, openQuestionKeys(state));
  // Several commands from one message share a timestamp. Anything already asked at this instant belongs to the
  // same turn, and one turn asks at most two questions.
  if (cleared.pendingQuestions.some((q) => q.askedAt === now)) return { state: cleared, replies: [] };
  const { questions } = checkReadiness(cleared, { now, ...(actorId !== undefined ? { actorId } : {}) });
  return { state: recordQuestions(cleared, questions, now), replies: toReplies(questions) };
}

// ---- what counts as a material change --------------------------------------------------------------

/**
 * Every hard fact the plan depends on, as comparable text. A tentative statement or a restatement of the same
 * value leaves it unchanged; so do soft preferences, which can re-rank options but never void a plan.
 */
function materialFacts(state: TripState): Map<string, string> {
  const facts = new Map<string, string>();
  for (const id of participantIds(state)) {
    facts.set(`budget:${id}`, JSON.stringify(effectiveBudget(state, id) ?? null));
    facts.set(`availability:${id}`, JSON.stringify(effectiveAvailability(state, id) ?? null));
    facts.set(`must_dos:${id}`, JSON.stringify(effectiveMustDos(state, id)));
  }
  for (const field of ['origin', 'duration', 'region', 'transport'] as const) {
    facts.set(`group:${field}`, JSON.stringify(resolveGroupField(state, field)));
  }
  return facts;
}

function changedFacts(before: TripState, after: TripState): string[] {
  const a = materialFacts(before);
  const b = materialFacts(after);
  return [...b.keys()].filter((key) => a.get(key) !== b.get(key));
}

const GROUP_LABEL: Record<string, string> = {
  origin: 'where you leave from',
  duration: 'how long the trip is',
  region: 'where you are going',
  transport: 'the car situation',
};

/** Why the plan changed, in words that never reveal a budget. */
function describeChanges(state: TripState, keys: readonly string[]): string {
  const parts = new Set<string>();
  for (const key of keys) {
    const [kind, who] = key.split(':');
    if (kind === 'budget') parts.add('a budget limit changed');
    else if (kind === 'availability') parts.add(`${displayName(state, who)}'s available dates changed`);
    else if (kind === 'must_dos') parts.add(`${displayName(state, who)}'s requirements changed`);
    else parts.add(`${GROUP_LABEL[who] ?? 'a trip detail'} changed`);
  }
  const text = [...parts].join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---- revisions ---------------------------------------------------------------------------------------

/**
 * Start a new revision after a material change: earlier acceptances no longer apply, every candidate is
 * re-checked against the new facts, and the status falls back to the furthest stage that is still true.
 */
function startNewRevision(state: TripState, changed: readonly string[]): { state: TripState; replies: TripReply[]; researchRequested: boolean } {
  const revision = state.revision + 1;
  const hadPlan = state.candidates.length > 0;
  const before = new Map(state.candidates.map((c) => [c.candidateId, c.feasibility.feasible]));
  const revised: TripState = { ...state, revision, acceptances: [] };
  const candidates = state.candidates.map((c) => reprice(revised, { ...c, revision }));
  const selectedOk = candidates.find((c) => c.candidateId === state.selectedCandidateId)?.feasibility.feasible === true;

  const next: TripState = { ...revised, candidates };
  if (!selectedOk) delete next.selectedCandidateId;

  const anyFeasible = candidates.some((c) => c.feasibility.feasible);
  const ready = checkReadiness(next).ready;
  let status: TripState['status'];
  let researchRequested = false;
  if (selectedOk) status = 'awaiting_acceptance';
  else if (anyFeasible) status = 'proposed';
  else if (ready && (hadPlan || state.status === 'researching')) {
    // Nothing standing is feasible, or research was running against facts that just changed: look again.
    status = 'researching';
    researchRequested = true;
  } else status = 'gathering';
  next.status = status;

  const replies: TripReply[] = [];
  if (hadPlan || state.status === 'researching' || state.acceptances.length > 0) {
    const lines = [`${describeChanges(state, changed)}, so I'm updating the plan.`];
    if (state.acceptances.length > 0) lines.push('Earlier approvals no longer apply.');
    for (const c of candidates) {
      if (before.get(c.candidateId) && !c.feasibility.feasible) lines.push(`${c.title} no longer fits everyone's limits, so I've dropped it.`);
    }
    if (selectedOk) {
      const chosen = candidates.find((c) => c.candidateId === next.selectedCandidateId) as TripCandidate;
      // While people still disagree on a basic (say the trip length), asking them to accept would contradict the question
      // that goes out next. They accept again once that is settled.
      if (ready) replies.push({ audience: GROUP, text: `${lines.join(' ')} Please accept ${chosen.title} again.`, proposalRef: { candidateId: chosen.candidateId, revision } });
      else replies.push({ audience: GROUP, text: `${lines.join(' ')} Once that's settled, you'll need to accept ${chosen.title} again.` });
    } else if (researchRequested) {
      replies.push({ audience: GROUP, text: `${lines.join(' ')} Give me a minute to look for options that fit.` });
    } else {
      replies.push({ audience: GROUP, text: lines.join(' ') });
    }
  }
  return { state: next, replies, researchRequested };
}

// ---- commands ---------------------------------------------------------------------------------------

function updateConstraint(state: TripState, command: TripCommand, update: ConstraintUpdate, now: string): ApplyResult {
  let validated: ConstraintUpdate;
  try {
    validated = validateUpdate(state, command.actorId, update);
  } catch (error) {
    if (error instanceof ConstraintError) return reject(state, command.actorId, error.code, error.userMessage);
    throw error;
  }
  const recorded = recordConstraint(state, validated, now);
  const changed = changedFacts(state, recorded);

  let next = recorded;
  let replies: TripReply[] = [];
  let researchRequested = false;
  if (changed.length > 0) {
    const revised = startNewRevision(recorded, changed);
    next = revised.state;
    replies = revised.replies;
    researchRequested = revised.researchRequested;
  }
  // Whatever is still missing, contradictory or only tentative gets asked about, at any stage of the plan.
  const asked = askAboutGaps(next, now, command.actorId);
  return { state: asked.state, replies: [...replies, ...asked.replies], researchRequested };
}

function requestPlans(state: TripState, command: TripCommand, now: string, requireSignOff = false): ApplyResult {
  if (state.status === 'approved') {
    return reject(state, command.actorId, 'AMBIGUOUS_ACTION', 'This trip is already approved. Change a detail first if you want new options.');
  }
  const readiness = checkReadiness(state, { now, requireSignOff });
  if (!readiness.ready) {
    const asked = askAboutGaps(state, now, command.actorId);
    // A question going out says what is missing by itself. Only when nothing new is asked (everything is waiting on
    // an earlier answer) is the requester told what the plan is still waiting for, so they are never met with silence.
    const to = { kind: 'private', memberId: command.actorId } as const;
    const reply = asked.replies.length === 0 ? [{ audience: to, text: describeGaps(state, readiness, command.actorId) }] : asked.replies;
    return {
      state: asked.state,
      replies: reply,
      researchRequested: false,
      rejection: { code: 'NOT_READY', userMessage: "I can't plan yet: some details are missing or don't agree." },
    };
  }
  return { state: { ...state, status: 'researching' }, replies: [], researchRequested: true };
}

function selectCandidate(state: TripState, command: TripCommand, candidateId: string, revision: number): ApplyResult {
  if (revision !== state.revision) {
    return reject(state, command.actorId, 'STALE_REVISION', 'That option is out of date. Please look at the latest plan.');
  }
  const candidate = state.candidates.find((c) => c.candidateId === candidateId);
  if (!candidate || candidate.revision !== state.revision) {
    return reject(state, command.actorId, 'AMBIGUOUS_ACTION', "I couldn't tell which option you mean. Please pick one from the latest plan.");
  }
  if (!candidate.feasibility.feasible) {
    return reject(state, command.actorId, 'INFEASIBLE_PLAN', `${candidate.title} doesn't fit everyone's limits, or has prices I can't verify yet, so it can't be chosen.`);
  }
  if (state.status === 'approved') {
    return reject(state, command.actorId, 'AMBIGUOUS_ACTION', 'This trip is already approved.');
  }
  if (state.status !== 'proposed' && state.status !== 'awaiting_acceptance') {
    return reject(state, command.actorId, 'NOT_READY', "There aren't any options to choose from yet.");
  }
  const acceptances = state.selectedCandidateId === candidateId ? state.acceptances : [];
  const next: TripState = { ...state, selectedCandidateId: candidateId, status: 'awaiting_acceptance', acceptances };
  const text = `${candidate.title} is the pick. Choosing it isn't agreeing to pay, so each of you needs to say "I'm in" to lock it in.`;
  return { state: next, replies: [{ audience: GROUP, text, proposalRef: { candidateId, revision: state.revision } }], researchRequested: false };
}

function acceptCandidate(state: TripState, command: TripCommand, candidateId: string, revision: number): ApplyResult {
  if (revision !== state.revision) {
    return reject(state, command.actorId, 'STALE_REVISION', 'That plan has changed since you replied. Please look at the latest version and accept it again.');
  }
  const candidate = state.candidates.find((c) => c.candidateId === candidateId);
  if (!candidate || state.selectedCandidateId !== candidateId || state.status !== 'awaiting_acceptance') {
    return reject(state, command.actorId, 'AMBIGUOUS_ACTION', "That isn't the plan that's up for approval right now.");
  }
  if (candidate.revision !== state.revision || !candidate.feasibility.feasible) {
    return reject(state, command.actorId, 'INFEASIBLE_PLAN', `${candidate.title} can't be approved: it doesn't fit everyone's limits or has prices I can't verify.`);
  }
  const already = state.acceptances.some((a) => a.memberId === command.actorId && a.candidateId === candidateId && a.revision === revision);
  const acceptances = already
    ? state.acceptances
    : [...state.acceptances, { memberId: command.actorId, candidateId, revision }];
  const waiting = participantIds(state).filter((id) => !acceptances.some((a) => a.memberId === id && a.candidateId === candidateId && a.revision === revision));
  const approved = waiting.length === 0;
  const next: TripState = { ...state, acceptances, status: approved ? 'approved' : 'awaiting_acceptance' };
  if (already) return { state: next, replies: [], researchRequested: false };
  if (approved) {
    const text = `Everyone's in, so ${candidate.title} is approved. Prices are estimates and nothing is booked yet.\nAdd it to your calendar: {{CALENDAR_LINK}}`;
    return { state: next, replies: [{ audience: GROUP, text, proposalRef: { candidateId, revision } }], researchRequested: false };
  }
  // Same words to every phone would tell someone "still waiting on <their own name>", so each person hears it their own way.
  const who = displayName(state, command.actorId);
  const names = waiting.map((id) => displayName(state, id));
  const replies: TripReply[] = [
    { audience: { kind: 'private', memberId: command.actorId }, text: `You're in. Still waiting on ${names.join(', ')}.` },
    ...waiting.map((id) => ({ audience: { kind: 'private' as const, memberId: id }, text: `${who} is in. Say "I'm in" when you're ready.`, proposalRef: { candidateId, revision } })),
  ];
  return { state: next, replies, researchRequested: false };
}

/**
 * Apply a command to the trip. Pure: no clock (unless `now` is omitted), no storage, no network. A rejected
 * command returns the same state with a private reply and a rejection code; a material change starts a new
 * revision, voids earlier acceptances and re-checks every candidate.
 *
 * `ask_guide` and `request_funding` change nothing here: guide answers come from `answerGuideQuestion`, and
 * funding belongs to the funding adapter once the plan is approved.
 */
export function applyCommand(state: TripState, command: TripCommand, options: ApplyOptions = {}): ApplyResult {
  const now = options.now ?? new Date().toISOString();
  if (command.tripId !== state.tripId) {
    return reject(state, command.actorId, 'AMBIGUOUS_ACTION', "That message doesn't belong to this trip.");
  }
  const actor = state.roster.find((m) => m.memberId === command.actorId);
  if (!actor || !actor.consented) {
    return reject(state, command.actorId, 'UNKNOWN_MEMBER', 'I can only act on messages from people who have agreed to plan this trip with me.');
  }
  const { action } = command;
  switch (action.kind) {
    case 'update_constraint':
      return updateConstraint(state, command, action.update, now);
    case 'request_plans':
      return requestPlans(state, command, now, options.requireSignOff === true);
    case 'select_candidate':
      return selectCandidate(state, command, action.candidateId, action.revision);
    case 'accept_candidate':
      return acceptCandidate(state, command, action.candidateId, action.revision);
    case 'ask_guide':
    case 'relay':   // messages between people are sent by the app, not planned here
    case 'fund_pay':
    case 'fund_spend':
      return { state, replies: [], researchRequested: false };
    case 'request_funding':
      if (state.status !== 'approved') {
        return reject(state, command.actorId, 'MISSING_APPROVAL', "Contributions can only be requested once everyone has approved a plan.");
      }
      return { state, replies: [], researchRequested: false };
    default:
      return reject(state, command.actorId, 'AMBIGUOUS_ACTION', "I didn't understand what to do with that.");
  }
}

/**
 * Install researched candidates, unless they were produced for an older revision. Stale research never
 * overwrites newer state: the caller keeps the current state and may ask again.
 */
export function installCandidates(state: TripState, researchedAtRevision: number, candidates: readonly TripCandidate[]): ApplyResult {
  if (researchedAtRevision !== state.revision) {
    return {
      state,
      replies: [],
      researchRequested: false,
      rejection: { code: 'STALE_REVISION', userMessage: 'The plan changed while I was researching, so I discarded those results.' },
    };
  }
  const priced = candidates.map((c) => reprice(state, { ...c, revision: state.revision }));
  const anyFeasible = priced.some((c) => c.feasibility.feasible);
  const next: TripState = { ...state, candidates: priced, acceptances: [], status: anyFeasible ? 'proposed' : 'gathering' };
  delete next.selectedCandidateId;
  return { state: next, replies: [], researchRequested: false };
}
