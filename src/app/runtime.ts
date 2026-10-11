import { createHash } from 'node:crypto';
import type { FundService } from '../funding/service.js';
import { categoryOfPurchase, describeCoverage, describePurchaseCheck, describeWrapUp, driftNotices, parsePurchaseAnswer, settleUpFor } from '../planning/funding.js';
import { accumulatePreferences } from '../planning/constraints.js';
import { toPlanningState } from './planning-adapter.js';
import type {
  ConstraintValue,
  ConversationContext,
  ConversationService,
  GroupConstraintRecord,
  InboundMessage,
  OutboundMessage,
  Repository,
  TripCandidate,
  TripCommand,
  TripState,
} from '../contracts/index.js';

export interface PlannerAdapter {
  guidePrivate?: boolean;
  applyCommand(state: TripState, command: TripCommand, options?: { now: string; deferQuestions?: boolean; requireSignOff?: boolean }): {
    state: TripState;
    replies: OutboundMessage[];
    researchRequested: boolean;
    rejection?: { code: string; userMessage: string };
  };
  generateCandidates(state: TripState): Promise<TripCandidate[]>;
  /** Ask whoever is holding things up for what is missing. Used when someone asks for options too early. */
  nudgeMissing?(state: TripState, actorId: string, now: string): { state: TripState; replies: OutboundMessage[] };
  finalizeTurn?(state: TripState, now: string, actorId?: string): { state: TripState; replies: OutboundMessage[] };
  research?(state: TripState): Promise<{ revision: number; candidates: TripCandidate[]; replies: OutboundMessage[] }>;
  install?(state: TripState, revision: number, candidates: TripCandidate[]): { state: TripState; rejection?: { code: string }; replies: OutboundMessage[] };
  guide?(state: TripState, question: string, now?: string): Promise<string>;
}

export interface ApplicationRuntimeDependencies {
  repository: Repository;
  conversation: ConversationService;
  planner: PlannerAdapter;
  tripId: string;
  /** Rewords outgoing chat messages so they read like a friend texting. Optional; the original text is sent if it is missing or fails. */
  voice?: { polish(text: string): Promise<string> };
  /** Address of the trip page, put into messages that point at the full plan. Defaults to the words "the trip page". */
  planUrl?: string;
  /** Address of the approved plan as a calendar file. Without it, the line that offers the calendar is left out. */
  calendarUrl?: string;
  fundService?: FundService;
  /** If a search is still running after this long, the group gets one short "still looking" text (default 45 s, 0 turns it off). */
  stillLookingMs?: number;
  /** How long `stop()` waits for work in flight (a search) before giving up on it. A search cut off here is resumed on the next start. Default 5 seconds. */
  stopWaitMs?: number;
  /** How often the bank is read for purchases worth asking the buyer about (default 2 minutes, 0 turns it off). */
  purchaseCheckMs?: number;
}

export interface ApplicationRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleInbound(message: InboundMessage): Promise<void>;
  /** Reads the bank and privately asks buyers about purchases the plan does not explain, one question per person at a time. */
  checkPurchases(): Promise<void>;
  drainOutbox(): Promise<void>;
  waitForIdle(): Promise<void>;
}

/** App composition boundary: identity, revision control, dedupe, outbox, and stale-research protection. */
export function createApplicationRuntime(dependencies: ApplicationRuntimeDependencies): ApplicationRuntime {
  const { repository, conversation, planner, tripId, fundService } = dependencies;
  /** Reword plain conversational messages (never ones carrying a plan, a link or money) in parallel, falling back to the original. */
  const polishAll = async (messages: OutboundMessage[]): Promise<OutboundMessage[]> => {
    const voice = dependencies.voice;
    if (!voice) return messages;
    return Promise.all(messages.map(async (m) => (m.proposalRef ? m : { ...m, text: await voice.polish(m.text).catch(() => m.text) })));
  };
  /** Messages from the planner point at the trip page with a token; this puts the real address in. */
  const withPlanLink = (text: string) => {
    const planned = text.replaceAll('{{PLAN_LINK}}', dependencies.planUrl ?? 'the trip page');
    if (!planned.includes('{{CALENDAR_LINK}}')) return planned;
    // No address means no calendar offer at all, rather than a line pointing nowhere.
    return dependencies.calendarUrl
      ? planned.replaceAll('{{CALENDAR_LINK}}', dependencies.calendarUrl)
      : planned.split('\n').filter((line) => !line.includes('{{CALENDAR_LINK}}')).join('\n').trimEnd();
  };
  const queued: Promise<void>[] = [];
  let processQueue: Promise<void> = Promise.resolve();
  let outboxDrain: Promise<void> | undefined;
  let stopped = false;
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  let purchaseTimer: ReturnType<typeof setInterval> | undefined;
  const researchRevisions = new Set<number>();

  const runtime: ApplicationRuntime = {
    async start() {
      stopped = false;
      await conversation.start((message) => runtime.handleInbound(message));
      await runtime.drainOutbox();
      retryTimer = setInterval(() => { void runtime.drainOutbox().catch(() => undefined); }, 5000);
      retryTimer.unref();
      const checkEvery = dependencies.purchaseCheckMs ?? 120_000;
      if (fundService && checkEvery > 0) {
        purchaseTimer = setInterval(() => { void runtime.checkPurchases().catch(() => undefined); }, checkEvery);
        purchaseTimer.unref();
      }
      const state = await repository.loadTrip(tripId);
      if (state?.status === 'researching') scheduleResearch(state);
    },

    async stop() {
      stopped = true;
      clearInterval(retryTimer);
      clearInterval(purchaseTimer);
      await conversation.stop();
      // A hung search must not make a clean shutdown hang too: wait a little, then leave it (it resumes on the next start).
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled(queued.splice(0)), new Promise<void>((resolve) => { timer = setTimeout(resolve, dependencies.stopWaitMs ?? 5_000); })]);
      clearTimeout(timer);
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

    async checkPurchases() {
      if (!fundService || stopped) return;
      const task = processQueue.then(() => askAboutPurchases());
      processQueue = task.catch(() => undefined);
      await task;
    },

    async drainOutbox() {
      if (outboxDrain) return outboxDrain;
      outboxDrain = (async () => {
        // A message the phone line refuses stays in the outbox, and nothing later for the same recipient is sent past it,
        // so people never read the second message before the first. Other recipients are not held up.
        const blocked = new Set<string>();
        for (const message of await repository.pendingMessages()) {
          const recipient = message.audience.kind === 'private' ? `private:${message.audience.memberId}` : `group:${message.audience.spaceId}`;
          if (blocked.has(recipient)) continue;
          try {
            const receipts = await conversation.sendMessage(message);
            await repository.recordDelivery(message.deliveryId, receipts.map(({ providerMessageId }) => providerMessageId));
          } catch {
            // Leave failed or uncertain sends in the durable outbox for operator inspection/retry.
            blocked.add(recipient);
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

  /** Purchases the plan does not explain are held back until the buyer says whether they were for the trip. */
  async function askAboutPurchases(): Promise<void> {
    if (!fundService) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await repository.loadTrip(tripId);
      if (!state || state.status !== 'approved') return;
      let flagged;
      try { const report = await fundService.inspect(state); flagged = report.toCheck ?? []; } catch { return; }
      const checks = { ...state.purchaseChecks };
      // One question per person at a time: the next one comes after they answer, never a burst.
      const busy = new Set(flagged.filter((f) => checks[f.purchase.id]?.status === 'asked').map((f) => f.purchase.memberId));
      const now = new Date().toISOString();
      const replies: OutboundMessage[] = [];
      for (const flag of flagged) {
        const { id, memberId } = flag.purchase;
        if (checks[id] || busy.has(memberId)) continue;
        busy.add(memberId);
        checks[id] = { memberId, status: 'asked', askedAt: now, dollars: flag.purchase.amountDollars, category: categoryOfPurchase(flag.purchase) ?? 'other' };
        replies.push(makeMessage(tripId, `purchase-ask:${id}`, { audience: { kind: 'private', memberId }, text: describePurchaseCheck(flag) }));
      }
      if (replies.length === 0) return;
      const result = await repository.commitEvent({ eventId: `purchase-check:${replies.map((r) => r.deliveryId).join(',')}`, state: { ...state, purchaseChecks: checks }, expectedRevision: state.revision, messages: replies });
      if (result === 'stale') continue;
      if (result === 'committed') await runtime.drainOutbox();
      return;
    }
  }

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

      // A short "trip" or "personal" answers the oldest purchase question this person has open (only when nothing else is waiting on a yes).
      const answer = fundService && state.status === 'approved' && !state.pendingConfirmations?.[member.memberId] && !state.pendingQuestions.some((q) => q.memberId === member.memberId) ? parsePurchaseAnswer(message.text) : undefined;
      const openCheck = answer ? Object.entries(state.purchaseChecks ?? {}).filter(([, c]) => c.memberId === member.memberId && c.status === 'asked' && Date.parse(message.occurredAt) - Date.parse(c.askedAt) < 3 * 86_400_000).sort((a, b) => a[1].askedAt.localeCompare(b[1].askedAt))[0] : undefined;
      if (answer && openCheck) {
        const [purchaseId, check] = openCheck;
        const text = answer === 'trip'
          ? `Thanks, I'll count your $${check.dollars} as a shared trip cost. This is simulated sandbox money.`
          : `Okay, I'll leave your $${check.dollars} out of the split. It stays personal.`;
        // They have just told us what it was, so the "over budget / not budgeted" heads-up about that category would only nag.
        const noticeKey = String(state.revision);
        const quiet = answer === 'trip' && check.category ? { fundingNoticeKeys: { ...state.fundingNoticeKeys, [noticeKey]: [...new Set([...(state.fundingNoticeKeys?.[noticeKey] ?? []), `${check.category}:over`])] } } : {};
        const result = await repository.commitEvent({ eventId: message.eventId, state: { ...state, ...quiet, purchaseChecks: { ...state.purchaseChecks, [purchaseId]: { ...check, status: answer } } }, expectedRevision: state.revision, messages: [makeMessage(tripId, `purchase-answer:${message.eventId}`, { audience: { kind: 'private', memberId: member.memberId }, text })] });
        if (result === 'stale') continue;
        if (result === 'committed') await runtime.drainOutbox();
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
        const result = await repository.commitEvent({ eventId: message.eventId, state: { ...state, pendingConfirmations: confirmations }, expectedRevision: state.revision, messages: await polishAll([parsed.message]) });
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

      // A plain "Got it" is said FIRST, before any question and does NOT stop the next question; a real clarifying question does.
      if (parsed.kind === 'commands' && parsed.acknowledgement) {
        replies.push(makeMessage(tripId, `ack:${message.eventId}`, { audience: { kind: 'private', memberId: member.memberId }, text: parsed.acknowledgement }));
      }
      let fundRequested = false;
      let fundTopic: 'status' | 'remind' | 'wrap_up' = 'status';

      for (const [index, parsedCommand] of commands.entries()) {
        const command: TripCommand = {
          ...parsedCommand,
          commandId: deterministicCommandId(tripId, message.eventId, parsedCommand.action.kind, index),
          eventId: message.eventId,
          actorId: member.memberId,
          tripId,
        };
        if (command.action.kind === 'request_funding') { fundRequested = true; fundTopic = command.action.topic ?? 'status'; continue; }
        if (command.action.kind === 'ask_guide' && planner.guide) {
          let text: string;
          try { text = await planner.guide(nextState, command.action.question, message.occurredAt); }
          catch { text = 'Trip research is unavailable. Please retry; no fixture answer was substituted.'; }
          replies.push(makeMessage(tripId, `guide:${message.eventId}:${index}`, { audience: message.visibility === 'private' || planner.guidePrivate ? { kind: 'private', memberId: member.memberId } : { kind: 'group', spaceId: enrollment.groupSpaceId }, text }));
          continue;
        }
        let applied: ReturnType<PlannerAdapter['applyCommand']>;
        try {
          applied = planner.applyCommand(nextState, command, { now: message.occurredAt, deferQuestions: Boolean(planner.finalizeTurn) });
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
        replies.push(...applied.replies.map((reply) => ({ ...reply, text: withPlanLink(reply.text) })).map((reply, replyIndex) => planner.install ? makeMessage(tripId, `${message.eventId}:${index}:${replyIndex}`, { ...reply, proposalRef: reply.proposalRef ? { ...reply.proposalRef, kind: applied.state.status === 'awaiting_acceptance' || applied.state.status === 'approved' ? 'accept' : 'select' } : undefined }) : reply));
        researchRequested = applied.researchRequested;
        // Asked for options too early? Message whoever is holding things up, so it is not left to the requester to chase them.
        if (command.action.kind === 'request_plans' && applied.rejection?.code === 'NOT_READY' && planner.nudgeMissing) {
          const nudged = planner.nudgeMissing(nextState, member.memberId, message.occurredAt);
          nextState = nudged.state;
          replies.push(...nudged.replies.map((reply, nudgeIndex) => makeMessage(tripId, `nudge:${message.eventId}:${nudgeIndex}`, reply)));
          if (nudged.replies.length > 0) replies.push(makeMessage(tripId, `nudged:${message.eventId}`, { audience: { kind: 'private', memberId: member.memberId }, text: `I'll nudge ${nudged.replies.map((r) => (r.audience.kind === 'private' ? state.roster?.find((m) => m.memberId === (r.audience as { memberId: string }).memberId)?.displayName : undefined)).filter(Boolean).join(' and ')} for what I'm missing and let you know as soon as I have it.` }));
        }
      }
      if (planner.finalizeTurn && !(parsed.kind === 'commands' && parsed.clarificationQuestion) && commands.some(c => c.action.kind === 'update_constraint' || c.action.kind === 'request_plans')) {
        const final = planner.finalizeTurn(nextState, message.occurredAt, member.memberId);
        nextState = final.state;
        // In a one-on-one chat a shared question is asked of the person talking, not copied to everyone else's phone.
        // A conflict (like dates that don't overlap) is different: everyone has to hear it to fix it, so it goes to all.
        const conflicts = new Set(final.state.pendingQuestions.filter((q) => q.questionId.startsWith('conflict:')).map((q) => q.text));
        const asked = final.replies.map((reply, index) => makeMessage(tripId, `questions:${message.eventId}:${index}`,
          message.visibility === 'private' && reply.audience.kind === 'group' && !conflicts.has(reply.text) ? { ...reply, audience: { kind: 'private', memberId: member.memberId } } : reply));
        // A person is never handed two questions in one turn: a fresh question replaces an earlier re-ask of an old one.
        const isQuestion = (r: OutboundMessage) => r.audience.kind === 'private' && r.text.trim().endsWith('?');
        // If a disagreement is being announced, that is the one thing to deal with this turn; other questions wait.
        if (asked.some((r) => conflicts.has(r.text))) asked.splice(0, asked.length, ...asked.filter((r) => conflicts.has(r.text) || !isQuestion(r)));
        const askedFor = new Set(asked.filter(isQuestion).map((r) => (r.audience as { memberId: string }).memberId));
        for (let i = replies.length - 1; i >= 0; i -= 1) if (isQuestion(replies[i]!) && askedFor.has((replies[i]!.audience as { memberId: string }).memberId)) replies.splice(i, 1);
        replies.push(...asked);
        // When a disagreement gets settled, tell everyone how it ended instead of letting it go quiet.
        const conflictKeys = (s: TripState) => new Set(s.pendingQuestions.filter((q) => q.questionId.startsWith('conflict:')).map((q) => q.questionId.split('|')[0]!));
        const stillOpen = conflictKeys(final.state);
        for (const key of conflictKeys(state)) {
          if (stillOpen.has(key)) continue;
          const text = settledText(key, final.state);
          if (text) replies.push(makeMessage(tripId, `settled:${message.eventId}:${key}`, { audience: { kind: 'group', spaceId: enrollment.groupSpaceId }, text }));
        }
      }
      // Once the last missing detail is in, start looking for options without waiting to be asked.
      if (!researchRequested && nextState.status === 'gathering' && commands.some((c) => c.action.kind === 'update_constraint') && !(parsed.kind === 'commands' && parsed.clarificationQuestion)) {
        const auto: TripCommand = { commandId: deterministicCommandId(tripId, message.eventId, 'auto_plan'), eventId: message.eventId, actorId: member.memberId, tripId, action: { kind: 'request_plans' } } as TripCommand;
        let probe: ReturnType<PlannerAdapter['applyCommand']> | undefined;
        try { probe = planner.applyCommand(nextState, auto, { now: message.occurredAt, requireSignOff: true }); } catch { probe = undefined; }
        if (probe && !probe.rejection && probe.researchRequested) {
          nextState = probe.state;
          researchRequested = true;
          replies.push(makeMessage(tripId, `auto-plan:${message.eventId}`, { audience: { kind: 'group', spaceId: enrollment.groupSpaceId }, text: "I have what I need from everyone, so I'm looking up options now. Give me a minute." }));
        }
        // Everything is in except someone's OK on the plan so far? Then that person is what is holding things up, so ask them
        // (once), and tell whoever just finished that this is what the search is waiting on.
        else if (probe?.rejection?.code === 'NOT_READY' && planner.nudgeMissing) {
          let soft: ReturnType<PlannerAdapter['applyCommand']> | undefined;
          try { soft = planner.applyCommand(nextState, auto, { now: message.occurredAt }); } catch { soft = undefined; }
          if (soft && !soft.rejection && soft.researchRequested) {
            const nudged = planner.nudgeMissing(nextState, member.memberId, message.occurredAt);
            if (nudged.replies.length > 0) {
              nextState = nudged.state;
              replies.push(...nudged.replies.map((reply, nudgeIndex) => makeMessage(tripId, `signoff-nudge:${message.eventId}:${nudgeIndex}`, reply)));
              const names = nudged.replies.map((r) => (r.audience.kind === 'private' ? state.roster?.find((m) => m.memberId === (r.audience as { memberId: string }).memberId)?.displayName : undefined)).filter(Boolean).join(' and ');
              replies.push(makeMessage(tripId, `signoff-told:${message.eventId}`, { audience: { kind: 'private', memberId: member.memberId }, text: `That's everything from you. I just need ${names}'s OK on the plan so far, so I've asked, and I'll start looking as soon as they say yes.` }));
            }
          }
        }
      }
      // Someone changed a shared detail the others already had? Tell them, so nobody plans around the old one.
      // Each note gets its own number: two changes in one message start with the same words, and an id built from the
      // wording alone made them collide and the whole message fail.
      basicsChangeNotes(state, nextState, member.memberId).forEach((text, noteIndex) => {
        // Only people who have joined in: someone who has never texted the bot is not told about changes out of the blue.
        for (const other of (state.roster ?? []).filter((m) => m.memberId !== member.memberId && m.consented && state.memberConstraints.some((c) => c.memberId === m.memberId))) {
          replies.push(makeMessage(tripId, `changed:${message.eventId}:${other.memberId}:${noteIndex}`, { audience: { kind: 'private', memberId: other.memberId }, text }));
        }
      });
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
      if (fundService && nextState.status !== 'approved') nextState = { ...nextState, fundingStatus: 'unknown' };
      if (fundService && (fundRequested || nextState.status === 'approved')) {
        try {
          const report = await fundService.inspect(nextState);
          if (report.coverage && report.plan) {
            const keys = new Set(nextState.fundingNoticeKeys?.[String(nextState.revision)] ?? []);
            // One notice per message: more than one at once reads as a wall of warnings. The rest follow next time.
            const notice = driftNotices(report.coverage.spend, keys)[0];
            if (notice) {
              keys.add(notice.key);
              replies.push(makeMessage(tripId, `fund-drift:${nextState.revision}:${notice.key}`, { audience: { kind: 'group', spaceId: enrollment.groupSpaceId }, text: `${notice.text} This is simulated sandbox money.` }));
            }
            nextState = { ...nextState, fundingStatus: report.status, fundingNoticeKeys: { ...nextState.fundingNoticeKeys, [String(nextState.revision)]: [...keys] } };
            if (fundRequested) {
              const planning = toPlanningState(nextState);
              const privately = (id: string, text: string, tag: string) => makeMessage(tripId, tag, { audience: { kind: 'private', memberId: id }, text });
              if (fundTopic === 'wrap_up') {
                replies.push(makeMessage(tripId, `fund-wrap:${message.eventId}`, { audience: { kind: 'group', spaceId: enrollment.groupSpaceId }, text: describeWrapUp(planning, report.coverage, { simulated: true }) }));
              } else if (fundTopic === 'remind') {
                // Nobody is nudged more than once a day, however often someone asks: pressure helps no one.
                const day = message.occurredAt.slice(0, 10);
                const tag = (id: string) => `reminded:${id}:${day}`;
                const debtors = [...new Set(report.coverage.transfers.map((t) => t.fromMemberId))].filter((id) => id !== member.memberId);
                const due = debtors.filter((id) => !keys.has(tag(id)));
                for (const id of due) {
                  const text = settleUpFor(planning, id, report.coverage);
                  if (text) { replies.push(privately(id, text, `fund-remind:${message.eventId}:${id}`)); keys.add(tag(id)); }
                }
                nextState = { ...nextState, fundingNoticeKeys: { ...nextState.fundingNoticeKeys, [String(nextState.revision)]: [...keys] } };
                const nameOf = (id: string) => planning.roster.find((m) => m.memberId === id)?.displayName ?? id;
                const nameList = (ids: string[]) => (ids.length > 1 ? `${ids.slice(0, -1).map(nameOf).join(', ')} and ${nameOf(ids.at(-1)!)}` : nameOf(ids[0]!));
                const already = debtors.filter((id) => !due.includes(id));
                const own = settleUpFor(planning, member.memberId, report.coverage);
                const told = due.length > 0
                  ? `Reminded ${nameList(due)}.${already.length > 0 ? ` ${nameList(already)} already got one today.` : ''}`
                  : already.length > 0 ? `I already reminded ${nameList(already)} today, so I'll leave them alone until tomorrow.` : "Nobody else owes anything right now, so there's nobody to remind.";
                replies.push(privately(member.memberId, own ? `${told}\n${own}` : told, `fund:${message.eventId}`));
              } else {
                const waiting = report.toCheck.reduce((sum, f) => sum + f.purchase.amountDollars, 0);
                const note = waiting > 0 ? `\n$${waiting} is waiting on whoever bought it to say if it was for the trip, so it isn't counted yet.` : '';
                replies.push(privately(member.memberId, describeCoverage(planning, report.plan, report.coverage, { simulated: true }) + note, `fund:${message.eventId}`));
              }
            }
          } else if (fundRequested) replies.push(makeMessage(tripId, `fund:${message.eventId}`, { audience: { kind: 'private', memberId: member.memberId }, text: report.reason ?? 'Approve the current plan before I track who covered what.' }));
        } catch {
          nextState = { ...nextState, fundingStatus: 'unknown' };
          if (fundRequested) replies.push(makeMessage(tripId, `fund:${message.eventId}`, { audience: { kind: 'private', memberId: member.memberId }, text: "I can't reach the bank right now, so I can't tell who covered what. I haven't guessed." }));
        }
      } else if (fundRequested) replies.push(makeMessage(tripId, `fund:${message.eventId}`, { audience: { kind: 'private', memberId: member.memberId }, text: "Tracking who covered what isn't set up (it's an optional extra)." }));
      const result = await repository.commitEvent({
        eventId: message.eventId,
        state: nextState,
        expectedRevision: state.revision,
        messages: await polishAll(replies),
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
    const timer = setTimeout(() => { void sendStillLooking(state.revision).catch(() => undefined); }, dependencies.stillLookingMs ?? 45_000);
    timer.unref?.();
    if ((dependencies.stillLookingMs ?? 45_000) <= 0) clearTimeout(timer);
    void task.finally(() => {
      clearTimeout(timer);
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
    // Asking again at the same revision (after "nothing fits", say) is a new search with its own answer, so each run has its own id.
    // Without this the second answer was dropped as a duplicate of the first and the trip stayed stuck on "researching".
    const attempt = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const messages = researchReplies
      ? researchReplies.map((reply, index) => makeMessage(tripId, `research:${sourceState.revision}:${attempt}:${index}`, { ...reply, text: withPlanLink(reply.text), proposalRef: reply.proposalRef ? { ...reply.proposalRef, kind: 'select' } : undefined }))
      : candidates.flatMap((candidate) => candidateMessages(candidate, tripId, groupSpaceId));
    const outcome = await repository.commitEvent({
      eventId: `research:${tripId}:${sourceState.revision}:${attempt}`,
      state: next,
      expectedRevision: current.revision,
      messages,
    });
    if (outcome === 'committed') await runtime.drainOutbox();
  }

  /** One short note per search that is taking a while, so nobody wonders whether the chat is stuck. */
  async function sendStillLooking(revision: number): Promise<void> {
    if (stopped) return;
    const current = await repository.loadTrip(tripId);
    const enrollment = await repository.getEnrollment(tripId);
    if (!current || current.revision !== revision || current.status !== 'researching' || !enrollment) return;
    const result = await repository.commitEvent({
      eventId: `still-looking:${tripId}:${revision}`,
      state: current,
      expectedRevision: revision,
      messages: [makeMessage(tripId, `still-looking:${revision}`, { audience: { kind: 'group', spaceId: enrollment.groupSpaceId }, text: "Still looking. This one's taking a little longer than usual, and I'll send options as soon as I have them." })],
    });
    if (result === 'committed') await runtime.drainOutbox();
  }

  async function reportResearchFailure(revision: number): Promise<void> {
    const current = await repository.loadTrip(tripId);
    const enrollment = await repository.getEnrollment(tripId);
    if (!current || current.revision !== revision || !enrollment) return;
    // Each failed attempt gets its own notice: a fixed id would swallow the second failure and leave people waiting in silence.
    const attempt = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const message = makeMessage(tripId, `research-failed:${revision}:${attempt}`, {
      audience: { kind: 'group', spaceId: enrollment.groupSpaceId },
      text: 'Sorry, I couldn\'t look up options just now. Nothing about your plan changed. Say "show us some options" to try again.',
    });
    const result = await repository.commitEvent({
      eventId: `research-failed:${tripId}:${revision}:${attempt}`,
      // Nothing is being looked up any more, so the trip must not keep saying "still looking".
      state: current.status === 'researching' ? { ...current, status: 'gathering' } : current,
      expectedRevision: revision,
      messages: [message],
    });
    if (result === 'committed') await runtime.drainOutbox();
  }

  return runtime;
}

async function conversationContext(repository: Repository, state: TripState, message: InboundMessage): Promise<ConversationContext> {
  const actorId = message.senderId;
  // What was asked of this person comes first (a private question is theirs alone), then the shared one that anyone may answer.
  const relevant = state.pendingQuestions
    .filter((question) => question.audience === 'group' || question.memberId === actorId)
    .sort((left, right) => Number(right.memberId === actorId) - Number(left.memberId === actorId) || right.askedAt.localeCompare(left.askedAt));
  const pendingQuestion = relevant[0];
  const openFields = [...new Set(relevant.flatMap((q) => (q.field ? [q.field] : [])))];
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
  // Someone who has not weighed in on the shared basics can agree with a plain "yes" or "sounds good" whether or not the bot got to ask yet
  // (a hello does not trigger the question), so the search is not left waiting on an answer nobody was asked for.
  const basics = sharedBasics(state);
  const unsigned = basics.length === 4 && !state.groupConstraints.some((c) => c.memberId === actorId);
  const confirmBasics = unsigned || state.pendingQuestions.some((q) => q.questionId.startsWith('confirm_basics:') && q.memberId === actorId) ? basics : [];
  return {
    tripId: state.tripId,
    revision: state.revision,
    status: state.status,
    actionable,
    ...(confirmBasics.length > 0 ? { confirmBasics } : {}),
    ...(openFields.length > 1 ? { openFields } : {}),
    others: othersShared(state, actorId),
    pendingConfirmation: state.pendingConfirmations?.[actorId],
    ...(targetProposal ? { targetProposal } : {}),
    ...(pendingQuestion?.field ? { pendingQuestion: { questionId: pendingQuestion.questionId, field: pendingQuestion.field } } : {}),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov 14-17": a saved window shown as days in its own time zone (a midnight end means through the day before). */
function dayRange(startAt: string, endAt: string, timeZone: string): string {
  const part = (ms: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value]));
    return { m: Number(p.month), d: Number(p.day), h: Number(p.hour) };
  };
  const s = part(Date.parse(startAt));
  const endMs = Date.parse(endAt);
  const e = part(part(endMs).h === 0 ? endMs - 3_600_000 : endMs);
  return s.m === e.m && s.d === e.d ? `${MONTHS[s.m - 1]} ${s.d}` : s.m === e.m ? `${MONTHS[s.m - 1]} ${s.d}-${e.d}` : `${MONTHS[s.m - 1]} ${s.d}-${MONTHS[e.m - 1]} ${e.d}`;
}

/** What each other person has said that is fine to repeat, and what is still missing from them. Never a budget. */
function othersShared(state: TripState, actorId: string): Array<{ memberId: string; name: string; shared: string[]; missing: string[] }> {
  return (state.roster ?? []).filter((m) => m.memberId !== actorId && m.consented).map((m) => {
    const latest = (field: string) => [...state.memberConstraints].reverse().find((c) => c.memberId === m.memberId && c.field === field && c.certainty === 'confirmed');
    const shared: string[] = [];
    const missing: string[] = [];
    const dates = latest('availability');
    if (dates && dates.field === 'availability') shared.push(`is free ${dates.value.map((w) => dayRange(w.startAt, w.endAt, w.timeZone)).join(' and ')}`); else missing.push('dates');
    const prefRecords = state.memberConstraints.filter((c) => c.memberId === m.memberId && c.field === 'preferences' && c.certainty === 'confirmed');
    const prefs = prefRecords.length > 0 ? prefRecords : undefined;
    const likes = prefs ? accumulatePreferences(prefRecords.map((c) => (c.field === 'preferences' ? c.value : []))).filter((v) => !/\$|\d|\b(?:budget|max(?:imum)?)\b/i.test(v)) : [];   // never repeat anything that mentions money
    if (prefs && likes.length > 0) shared.push(likes.includes('no preference') ? 'has no strong preferences' : `is into ${likes.join(' and ')}`); else missing.push('preferences');
    const must = latest('must_dos');
    if (must && must.field === 'must_dos' && must.value.length > 0) shared.push(`has must-haves: ${must.value.join(', ')}`);
    // What they said about the shared basics counts too ("I'd rather do 3 nights"), so "what did Mason say?" is not empty after they weighed in.
    const said = <F extends GroupConstraintRecord['field']>(field: F) => [...state.groupConstraints].reverse().find((c): c is Extract<GroupConstraintRecord, { field: F }> => c.field === field && c.memberId === m.memberId);
    const nights = said('duration'), from = said('origin'), place = said('region'), car = said('transport');
    if (nights) shared.push(`wants ${nights.value.nights} night${nights.value.nights === 1 ? '' : 's'}`);
    if (from) shared.push(`is leaving from ${from.value.city}`);
    if (place) shared.push(/^(?:within|any)\b/i.test(place.value.label) ? `is up for ${place.value.label}` : `wants to go to ${place.value.label}`);
    if (car) shared.push(car.value.hasVehicle ? 'has a car' : "doesn't have a car");
    if (!latest('budget')) missing.push('budget');
    return { memberId: m.memberId, name: m.displayName, shared, missing };
  });
}

/** A short heads-up for each shared basic (starting city, length, place, car) that someone just changed from a value that was already set. */
function basicsChangeNotes(before: TripState, after: TripState, actorId: string): string[] {
  const who = before.roster?.find((m) => m.memberId === actorId)?.displayName ?? 'Someone';
  const was = sharedBasics(before);
  const now = sharedBasics(after);
  const open = (field: string) => after.pendingQuestions.some((q) => q.questionId.startsWith(`conflict:${field}`));
  const wasOpen = (field: string) => before.pendingQuestions.some((q) => q.questionId.startsWith(`conflict:${field}`));   // a disagreement that was just settled already gets its own "Great, ..." message
  const notes: string[] = [];
  for (const b of now) {
    const a = was.find((x) => x.field === b.field);
    if (!a || JSON.stringify(a) === JSON.stringify(b) || open(b.field) || wasOpen(b.field)) continue;   // new, unchanged, or already being sorted out as a disagreement
    const ask = " Shout if that doesn't work for you.";
    if (b.field === 'origin') notes.push(`${who} changed the starting point to ${b.value}.${ask}`);
    else if (b.field === 'duration') notes.push(`${who} changed the trip to ${b.value} night${b.value === 1 ? '' : 's'}.${ask}`);
    else if (b.field === 'region') notes.push(`${who} changed the place to ${b.value}.${ask}`);
    else if (b.field === 'transport' && b.vehicleAvailable === false) notes.push(`Heads up, ${who} says there isn't a car after all.${ask}`);
  }
  return notes;
}

/** A friendly line for a disagreement that has just been settled. */
function settledText(key: string, state: TripState): string | undefined {
  const basics = sharedBasics(state);
  const value = (field: ConstraintValue['field']) => basics.find((b) => b.field === field);
  switch (key) {
    case 'conflict:duration': { const d = value('duration'); return d && d.field === 'duration' ? `Great, ${d.value} night${d.value === 1 ? '' : 's'} it is.` : undefined; }
    case 'conflict:origin': { const o = value('origin'); return o && o.field === 'origin' ? `Great, we'll plan the trip from ${o.value}.` : undefined; }
    case 'conflict:region': { const r = value('region'); return r && r.field === 'region' ? `Great, we'll plan around ${r.value}.` : undefined; }
    case 'conflict:transport': return "Great, so we've got a car.";
    case 'conflict:dates': return 'Nice, your dates line up now.';
    default: return undefined;
  }
}

/** The group's current origin, length, place and car, as values a "yes" can record for the person answering. */
function sharedBasics(state: TripState): ConstraintValue[] {
  const latest = <F extends GroupConstraintRecord['field']>(field: F) => [...state.groupConstraints].reverse().find((c): c is Extract<GroupConstraintRecord, { field: F }> => c.field === field);
  const out: ConstraintValue[] = [];
  const origin = latest('origin'), duration = latest('duration'), region = latest('region'), transport = latest('transport');
  if (origin) out.push({ field: 'origin', value: origin.value.city });
  if (duration) out.push({ field: 'duration', value: duration.value.nights });
  if (region) out.push({ field: 'region', value: region.value.label, ...(region.value.maxTravelMinutes !== undefined ? { maxTravelMinutes: region.value.maxTravelMinutes } : {}) });
  if (transport) out.push({ field: 'transport', value: transport.value.hasVehicle ? 'own_vehicle' : 'no_vehicle', vehicleAvailable: transport.value.hasVehicle });
  return out;
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

