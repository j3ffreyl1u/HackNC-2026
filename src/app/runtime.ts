import { createHash } from 'node:crypto';
import type {
  ConversationContext,
  ConversationService,
  InboundMessage,
  OutboundMessage,
  Repository,
  TripCandidate,
  TripCommand,
  TripState,
} from '../contracts/index.js';

export interface PlannerAdapter {
  guidePrivate?: boolean;
  applyCommand(state: TripState, command: TripCommand, options?: { now: string }): {
    state: TripState;
    replies: OutboundMessage[];
    researchRequested: boolean;
    rejection?: { code: string; userMessage: string };
  };
  generateCandidates(state: TripState): Promise<TripCandidate[]>;
  research?(state: TripState): Promise<{ revision: number; candidates: TripCandidate[]; replies: OutboundMessage[] }>;
  install?(state: TripState, revision: number, candidates: TripCandidate[]): { state: TripState; rejection?: { code: string }; replies: OutboundMessage[] };
  guide?(state: TripState, question: string, now?: string): Promise<string>;
}

export interface ApplicationRuntimeDependencies {
  repository: Repository;
  conversation: ConversationService;
  planner: PlannerAdapter;
  tripId: string;
}

export interface ApplicationRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleInbound(message: InboundMessage): Promise<void>;
  drainOutbox(): Promise<void>;
  waitForIdle(): Promise<void>;
}

/** App composition boundary: identity, revision control, dedupe, outbox, and stale-research protection. */
export function createApplicationRuntime(dependencies: ApplicationRuntimeDependencies): ApplicationRuntime {
  const { repository, conversation, planner, tripId } = dependencies;
  const queued: Promise<void>[] = [];
  let processQueue: Promise<void> = Promise.resolve();
  let outboxDrain: Promise<void> | undefined;
  let stopped = false;
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  const researchRevisions = new Set<number>();

  const runtime: ApplicationRuntime = {
    async start() {
      stopped = false;
      await conversation.start((message) => runtime.handleInbound(message));
      await runtime.drainOutbox();
      retryTimer = setInterval(() => { void runtime.drainOutbox().catch(() => undefined); }, 5000);
      retryTimer.unref();
      const state = await repository.loadTrip(tripId);
      if (state?.status === 'researching') scheduleResearch(state);
    },

    async stop() {
      stopped = true;
      clearInterval(retryTimer);
      await conversation.stop();
      await Promise.allSettled(queued.splice(0));
      await runtime.drainOutbox();
    },

    async waitForIdle() {
      await processQueue;
      while (queued.length) await Promise.allSettled([...queued]);
      await runtime.drainOutbox();
    },

    async handleInbound(message) {
      if (stopped) return;
      const task = processQueue.then(() => handleMessage(message));
      processQueue = task.catch(() => undefined);
      await task;
    },

    async drainOutbox() {
      if (outboxDrain) return outboxDrain;
      outboxDrain = (async () => {
        for (const message of await repository.pendingMessages()) {
          try {
            const receipts = await conversation.sendMessage(message);
            await repository.recordDelivery(message.deliveryId, receipts.map(({ providerMessageId }) => providerMessageId));
          } catch {
            // Leave failed or uncertain sends in the durable outbox for operator inspection/retry.
          }
        }
      })();
      try {
        await outboxDrain;
      } finally {
        outboxDrain = undefined;
      }
    },
  };

  async function handleMessage(message: InboundMessage): Promise<void> {
    if (await repository.hasProcessedEvent(message.eventId)) return;
    eventAttempt: for (let attempt = 0; attempt < 3; attempt += 1) {
      const enrollment = await repository.getEnrollment(tripId);
      const state = await repository.loadTrip(tripId);
      if (!enrollment || !state) return;

      const member = enrollment.participants.find((participant) => participant.memberId === message.senderId);
      if (!member || (message.visibility === 'group' && message.spaceId !== enrollment.groupSpaceId)) {
        const result = await repository.commitEvent({ eventId: message.eventId, state, expectedRevision: state.revision, messages: [] });
        if (result === 'stale') continue;
        return;
      }

      const context = await conversationContext(repository, state, message);
      const parsed = await conversation.parseInbound(message, context);
      if (parsed.kind === 'ignored') {
        const result = await repository.commitEvent({ eventId: message.eventId, state, expectedRevision: state.revision, messages: [] });
        if (result === 'stale') continue;
        return;
      }
      if (parsed.kind === 'reply') {
        const confirmations = { ...state.pendingConfirmations };
        if (parsed.expects) confirmations[member.memberId] = parsed.expects;
        else delete confirmations[member.memberId];
        const result = await repository.commitEvent({ eventId: message.eventId, state: { ...state, pendingConfirmations: confirmations }, expectedRevision: state.revision, messages: [parsed.message] });
        if (result === 'stale') continue;
        if (result === 'committed') await runtime.drainOutbox();
        return;
      }

      const commands = parsed.kind === 'command' ? [parsed.command] : parsed.commands;
      if (commands.length === 0 && !(parsed.kind === 'commands' && parsed.clarificationQuestion)) {
        const result = await repository.commitEvent({ eventId: message.eventId, state, expectedRevision: state.revision, messages: [] });
        if (result === 'stale') continue;
        return;
      }
      let nextState = state;
      let researchRequested = false;
      const replies: OutboundMessage[] = [];
      for (const [index, parsedCommand] of commands.entries()) {
        const command: TripCommand = {
          ...parsedCommand,
          commandId: deterministicCommandId(tripId, message.eventId, parsedCommand.action.kind, index),
          eventId: message.eventId,
          actorId: member.memberId,
          tripId,
        };
        if (command.action.kind === 'ask_guide' && planner.guide) {
          let text: string;
          try { text = await planner.guide(nextState, command.action.question, message.occurredAt); }
          catch { text = 'Trip research is unavailable. Please retry; no fixture answer was substituted.'; }
          replies.push(makeMessage(tripId, `guide:${message.eventId}:${index}`, { audience: message.visibility === 'private' || planner.guidePrivate ? { kind: 'private', memberId: member.memberId } : { kind: 'group', spaceId: enrollment.groupSpaceId }, text }));
          continue;
        }
        let applied: ReturnType<PlannerAdapter['applyCommand']>;
        try {
          applied = planner.applyCommand(nextState, command, { now: message.occurredAt });
        } catch (error) {
          const text = error instanceof Error && error.message.includes('group constraint has no author')
            ? 'This saved trip has group constraints with missing author information. An operator needs to migrate that information or start a separate trip before planning can continue. The saved plan is unchanged.'
            : 'I could not apply that trip update. Please ask the operator to inspect the integration and retry. The saved plan is unchanged.';
          const failure = makeMessage(tripId, `domain-failed:${message.eventId}`, { audience: { kind: 'private', memberId: member.memberId }, text });
          const result = await repository.commitEvent({ eventId: message.eventId, state, expectedRevision: state.revision, messages: [failure] });
          if (result === 'stale') continue eventAttempt;
          if (result === 'committed') await runtime.drainOutbox();
          return;
        }
        if (applied.state.tripId !== tripId || applied.state.revision < nextState.revision || applied.state.revision > nextState.revision + 1) {
          throw new Error('Planner returned a state for another trip or an invalid revision step.');
        }
        nextState = applied.state;
        replies.push(...applied.replies.map((reply, replyIndex) => planner.install ? makeMessage(tripId, `${message.eventId}:${index}:${replyIndex}`, { ...reply, proposalRef: reply.proposalRef ? { ...reply.proposalRef, kind: applied.state.status === 'awaiting_acceptance' || applied.state.status === 'approved' ? 'accept' : 'select' } : undefined }) : reply));
        researchRequested = applied.researchRequested;
      }
      if (parsed.kind === 'commands' && parsed.clarificationQuestion) {
        replies.push(makeMessage(tripId, `clarification:${message.eventId}`, {
          audience: message.visibility === 'private'
            ? { kind: 'private', memberId: member.memberId }
            : { kind: 'group', spaceId: enrollment.groupSpaceId },
          text: parsed.clarificationQuestion,
        }));
      }
      if (state.pendingConfirmations?.[member.memberId] || (parsed.kind === 'commands' && parsed.expects)) {
        const confirmations = { ...nextState.pendingConfirmations };
        if (parsed.kind === 'commands' && parsed.expects) confirmations[member.memberId] = parsed.expects;
        else delete confirmations[member.memberId];
        nextState = { ...nextState, pendingConfirmations: confirmations };
      }
      const result = await repository.commitEvent({
        eventId: message.eventId,
        state: nextState,
        expectedRevision: state.revision,
        messages: replies,
      });
      if (result === 'stale') continue;
      if (result !== 'committed') return;
      await runtime.drainOutbox();
      if (researchRequested) {
        scheduleResearch(nextState);
      }
      return;
    }
    throw new Error(`Could not apply event ${message.eventId} after repeated concurrent trip revisions.`);
  }

  function scheduleResearch(state: TripState) {
    if (stopped || researchRevisions.has(state.revision)) return;
    researchRevisions.add(state.revision);
    const task = runResearch(state).catch(() => undefined);
    queued.push(task);
    void task.finally(() => {
      researchRevisions.delete(state.revision);
      const index = queued.indexOf(task);
      if (index >= 0) queued.splice(index, 1);
    });
  }

  async function runResearch(sourceState: TripState): Promise<void> {
    let candidates: TripCandidate[];
    let researchReplies: OutboundMessage[] | undefined;
    try {
      if (planner.research) {
        const outcome = await planner.research(sourceState);
        if (outcome.revision !== sourceState.revision) throw new Error('Unexpected research revision');
        candidates = outcome.candidates;
        researchReplies = outcome.replies;
      } else candidates = await planner.generateCandidates(sourceState);
      if (candidates.some((candidate) => candidate.revision !== sourceState.revision)) {
        throw new Error('Research returned a candidate for a stale or unexpected trip revision.');
      }
    } catch {
      await reportResearchFailure(sourceState.revision);
      return;
    }

    const current = await repository.loadTrip(tripId);
    if (!current) return;
    if (current.revision !== sourceState.revision) {
      if (current.status === 'researching') scheduleResearch(current);
      return;
    }
    const installation = planner.install?.(current, sourceState.revision, candidates);
    if (installation?.rejection) return;
    const next: TripState = installation?.state ?? {
      ...current,
      status: 'proposed',
      candidates,
      selectedCandidateId: undefined,
      acceptances: [],
    };
    const groupSpaceId = (await repository.getEnrollment(tripId))?.groupSpaceId ?? '';
    const messages = researchReplies
      ? researchReplies.map((reply, index) => makeMessage(tripId, `research:${sourceState.revision}:${index}`, { ...reply, proposalRef: reply.proposalRef ? { ...reply.proposalRef, kind: 'select' } : undefined }))
      : candidates.flatMap((candidate) => candidateMessages(candidate, tripId, groupSpaceId));
    const outcome = await repository.commitEvent({
      eventId: `research:${tripId}:${sourceState.revision}`,
      state: next,
      expectedRevision: current.revision,
      messages,
    });
    if (outcome === 'committed') await runtime.drainOutbox();
  }

  async function reportResearchFailure(revision: number): Promise<void> {
    const current = await repository.loadTrip(tripId);
    const enrollment = await repository.getEnrollment(tripId);
    if (!current || current.revision !== revision || !enrollment) return;
    const message = makeMessage(tripId, `research-failed:${revision}`, {
      audience: { kind: 'group', spaceId: enrollment.groupSpaceId },
      text: 'I could not verify trip research for the current plan. The existing plan is unchanged; please retry when research is available.',
    });
    const result = await repository.commitEvent({
      eventId: `research-failed:${tripId}:${revision}`,
      state: current,
      expectedRevision: revision,
      messages: [message],
    });
    if (result === 'committed') await runtime.drainOutbox();
  }

  return runtime;
}

async function conversationContext(repository: Repository, state: TripState, message: InboundMessage): Promise<ConversationContext> {
  const actorId = message.senderId;
  const pendingQuestion = state.pendingQuestions
    .filter((question) => question.audience === 'group' || question.memberId === actorId)
    .sort((left, right) => right.askedAt.localeCompare(left.askedAt))[0];
  const targetProposal = message.reaction
    ? await repository.lookupProposal(message.reaction.targetMessageId)
    : null;
  const actionable = state.candidates.filter(candidate => candidate.revision === state.revision && candidate.feasibility.feasible).map(({ candidateId, revision, title }) => ({
    candidateId,
    revision,
    title,
    actions: [
      ...(state.status === 'proposed' ? ['pick' as const] : []),
      ...(state.status === 'awaiting_acceptance' && state.selectedCandidateId === candidateId && !state.acceptances.some(a => a.actorId === actorId && a.candidateId === candidateId && a.revision === revision) ? ['accept' as const] : []),
    ],
  })).filter((plan) => plan.actions.length > 0);
  return {
    tripId: state.tripId,
    revision: state.revision,
    status: state.status,
    actionable,
    pendingConfirmation: state.pendingConfirmations?.[actorId],
    ...(targetProposal ? { targetProposal } : {}),
    ...(pendingQuestion?.field ? { pendingQuestion: { questionId: pendingQuestion.questionId, field: pendingQuestion.field } } : {}),
  };
}

export function deterministicCommandId(tripId: string, eventId: string, action: string, index = 0): string {
  return `cmd-${createHash('sha256').update(JSON.stringify([tripId, eventId, action, index])).digest('hex').slice(0, 32)}`;
}

function makeMessage(
  tripId: string,
  identity: string,
  message: Omit<OutboundMessage, 'deliveryId'>,
): OutboundMessage {
  const digest = createHash('sha256').update(JSON.stringify([tripId, identity])).digest('hex').slice(0, 32);
  return { ...message, deliveryId: `delivery-${digest}` };
}

function candidateMessages(candidate: TripCandidate, tripId: string, spaceId: string): OutboundMessage[] {
  const totals = candidate.perPersonTotals.map((total) => `${total.memberId}: $${(total.highCents / 100).toFixed(2)} upper estimate`).join('; ');
  const sources = candidate.evidence.map((source) => `${source.title}: ${source.url}`).join('\n');
  const uncertainty = candidate.feasibility.unknownEssentials.length > 0
    ? ` Unknown essentials: ${candidate.feasibility.unknownEssentials.join(', ')}.`
    : '';
  const feasibility = candidate.feasibility.feasible
    ? ''
    : ' This option does not meet all hard constraints and cannot be accepted as feasible yet.';
  const message = makeMessage(tripId, `candidate:${candidate.candidateId}:${candidate.revision}`, {
    audience: { kind: 'group', spaceId },
    text: `${candidate.title} (${candidate.startAt} to ${candidate.endAt}). Per-person upper estimates: ${totals}.${feasibility}${uncertainty}\nSources:\n${sources}`,
    proposalRef: { candidateId: candidate.candidateId, revision: candidate.revision },
  });
  return [message];
}

