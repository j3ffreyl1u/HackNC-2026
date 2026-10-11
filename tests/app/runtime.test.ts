import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationContext,
  ConversationService,
  InboundMessage,
  OutboundMessage,
  ParseResult,
  TripCandidate,
  TripCommand,
  TripEnrollment,
  TripState,
} from '../../src/contracts/index.js';
import { createApplicationRuntime, deterministicCommandId, type PlannerAdapter } from '../../src/app/runtime.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';
import { createPlannerAdapter } from '../../src/app/planning-adapter.js';
import { createResearchProvider } from '../../src/research/provider.js';
import { defaultFixtures } from '../../src/research/fixtures.js';

const directories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'travel-runtime-'));
  directories.push(directory);
  const repository = SqliteTripRepository.open(join(directory, 'trips.sqlite'));
  const enrollment: TripEnrollment = {
    tripId: 'trip-runtime', groupSpaceId: 'friends', participants: [
      { memberId: 'mason', displayName: 'Mason', providerUserId: 'provider-mason' },
      { memberId: 'alex', displayName: 'Alex', providerUserId: 'provider-alex' },
      { memberId: 'jordan', displayName: 'Jordan', providerUserId: 'provider-jordan' },
    ],
  };
  const state: TripState = {
    tripId: enrollment.tripId, revision: 1, status: 'gathering', memberConstraints: [], groupConstraints: [],
    candidates: [], acceptances: [], pendingQuestions: [], fundingStatus: 'disabled',
  };
  return { repository, enrollment, state };
}

class FakeConversation implements ConversationService {
  parseInbound = vi.fn<(message: InboundMessage, context: ConversationContext) => Promise<ParseResult>>();
  sent: OutboundMessage[] = [];
  private callback?: (message: InboundMessage) => Promise<void>;

  async start(onMessage: (message: InboundMessage) => Promise<void>) { this.callback = onMessage; }
  async stop() { this.callback = undefined; }
  async sendMessage(message: OutboundMessage) {
    this.sent.push(message);
    return [{ providerMessageId: `provider-${message.deliveryId}` }];
  }
  async emit(message: InboundMessage) {
    if (!this.callback) throw new Error('Conversation was not started');
    await this.callback(message);
  }
}

function inbound(eventId: string, senderId = 'alex'): InboundMessage {
  return { eventId, messageId: `message-${eventId}`, senderId, spaceId: 'friends', visibility: 'group', occurredAt: '2026-10-10T12:00:00Z', text: 'make a plan' };
}

function command(eventId: string, actorId = 'forged-actor'): ParseResult {
  return {
    kind: 'command',
    command: { commandId: 'model-command-id', eventId: 'model-event-id', actorId, tripId: 'other-trip', action: { kind: 'request_plans' } },
  };
}

const noResearch: PlannerAdapter = {
  applyCommand: (state) => ({ state: { ...state, revision: state.revision + 1 }, replies: [], researchRequested: false }),
  generateCandidates: async () => [],
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('application runtime', () => {
  it('asks at most two readiness questions for a multi-command message and answers a cooldown-blocked request', async () => {
    const { repository, enrollment, state } = setup();
    state.roster = enrollment.participants.map(p => ({ memberId: p.memberId, displayName: p.displayName, consented: true }));
    const conversation = new FakeConversation();
    conversation.parseInbound.mockImplementation(async message => message.eventId === 'start'
      ? { kind: 'commands', commands: [0, 1].map(index => ({ commandId: `start-${index}`, eventId: message.eventId, actorId: 'alex', tripId: state.tripId, action: { kind: 'request_plans' as const } })) }
      : command(message.eventId));
    const planner = createPlannerAdapter(createResearchProvider({ mode: 'mock', fixtures: defaultFixtures }), enrollment.groupSpaceId);
    await repository.bootstrapTrip(enrollment, state);
    const runtime = createApplicationRuntime({ repository, conversation, planner, tripId: state.tripId });
    try {
      await runtime.start();
      await conversation.emit(inbound('start'));
      const questions = conversation.sent.filter(m => m.text.endsWith('?'));
      expect(questions).toHaveLength(2);
      expect(questions.map(m => m.text)).toEqual(['Where are you all leaving from?', 'How many nights are you thinking?']);
      expect((await repository.loadTrip(state.tripId))?.pendingQuestions).toHaveLength(2);
      const count = conversation.sent.length;
      await conversation.emit(inbound('again'));
      expect(conversation.sent.slice(count).some(m => m.text.includes("Mason's budget"))).toBe(true);
      expect(conversation.sent.slice(count).some(m => m.text.includes('where you want to go'))).toBe(true);
      expect(conversation.sent.slice(count).filter(m => m.text.endsWith('?')).length).toBeLessThanOrEqual(2);
    } finally { await runtime.stop(); repository.close(); }
  });
  it('reports missing legacy group authors privately without changing the saved trip', async () => {
    const { repository, enrollment, state } = setup();
    state.groupConstraints = [{ memberId: '', field: 'origin', value: { city: 'Chapel Hill', region: 'NC', timeZone: 'America/New_York' }, sourceMessageId: 'legacy-origin', certainty: 'confirmed' }];
    const conversation = new FakeConversation();
    conversation.parseInbound.mockResolvedValue(command('legacy-event'));
    await repository.bootstrapTrip(enrollment, state);
    const runtime = createApplicationRuntime({ repository, conversation, planner: createPlannerAdapter(createResearchProvider({ mode: 'mock', fixtures: defaultFixtures }), enrollment.groupSpaceId), tripId: state.tripId });
    try {
      await runtime.start();
      await expect(conversation.emit(inbound('legacy-event'))).resolves.toBeUndefined();
      expect(await repository.loadTrip(state.tripId)).toEqual(state);
      expect(await repository.hasProcessedEvent('legacy-event')).toBe(true);
      expect(conversation.sent).toHaveLength(1);
      expect(conversation.sent[0].audience).toEqual({ kind: 'private', memberId: 'alex' });
      expect(conversation.sent[0].text).toMatch(/missing author information/);
    } finally { await runtime.stop(); repository.close(); }
  });
  it('supplies actor-specific confirmations and binds every proposal delivery receipt', async () => {
    const { repository, enrollment, state } = setup();
    state.status = 'awaiting_acceptance';
    state.candidates = [candidate(state.revision)];
    state.selectedCandidateId = 'stale-candidate';
    state.acceptances = [{ actorId: 'mason', candidateId: 'stale-candidate', revision: state.revision, acceptedAt: '2026-10-10T12:00:00Z' }];
    state.pendingConfirmations = { alex: { field: 'budget', valueCents: 25000 } };
    state.pendingQuestions = [{ questionId: 'alex-budget', audience: 'private', memberId: 'alex', field: 'budget', text: 'What is your limit?', askedAt: '2026-10-10T12:00:00Z' }];
    const conversation = new FakeConversation();
    conversation.parseInbound.mockResolvedValue({ kind: 'ignored', reason: 'context check' });
    conversation.sendMessage = async () => [{ providerMessageId: 'receipt-alex' }, { providerMessageId: 'receipt-mason' }, { providerMessageId: 'receipt-jordan' }];
    await repository.bootstrapTrip(enrollment, state);
    await repository.enqueueMessages([{ deliveryId: 'proposal', audience: { kind: 'group', spaceId: enrollment.groupSpaceId }, text: 'Accept this revision', proposalRef: { candidateId: 'stale-candidate', revision: state.revision, kind: 'accept' } }]);
    const runtime = createApplicationRuntime({ repository, conversation, planner: noResearch, tripId: state.tripId });
    try {
      await runtime.start();
      for (const id of ['receipt-alex', 'receipt-mason', 'receipt-jordan']) expect(await repository.lookupProposal(id)).toEqual({ candidateId: 'stale-candidate', revision: state.revision, kind: 'accept' });
      await conversation.emit({ ...inbound('alex-context'), reaction: { targetMessageId: 'receipt-alex', emoji: 'like' } });
      const alex = conversation.parseInbound.mock.calls[0][1];
      expect(alex.actionable[0].actions).toEqual(['accept']);
      expect(alex.targetProposal?.kind).toBe('accept');
      expect(alex.pendingQuestion?.field).toBe('budget');
      expect(alex.pendingConfirmation?.valueCents).toBe(25000);
      await conversation.emit(inbound('mason-context', 'mason'));
      const mason = conversation.parseInbound.mock.calls[1][1];
      expect(mason.actionable).toEqual([]);
      expect(mason.pendingQuestion).toBeUndefined();
      expect(mason.pendingConfirmation).toBeUndefined();
    } finally { await runtime.stop(); repository.close(); }
  });
  it('binds actor/event/trip identity itself and makes provider event replay a no-op', async () => {
    const { repository, enrollment, state } = setup();
    const conversation = new FakeConversation();
    const observed: TripCommand[] = [];
    const reply: OutboundMessage = { deliveryId: 'reply-1', audience: { kind: 'group', spaceId: 'friends' }, text: 'Working on options.' };
    conversation.parseInbound.mockResolvedValue(command('event-1'));
    const planner: PlannerAdapter = {
      applyCommand(current, cmd) {
        observed.push(cmd);
        return { state: { ...current, revision: current.revision + 1 }, replies: [reply], researchRequested: false };
      },
      generateCandidates: async () => [],
    };
    await repository.bootstrapTrip(enrollment, state);
    const runtime = createApplicationRuntime({ repository, conversation, planner, tripId: state.tripId });
    await runtime.start();
    await conversation.emit(inbound('event-1'));
    await conversation.emit(inbound('event-1'));

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ actorId: 'alex', eventId: 'event-1', tripId: state.tripId });
    expect(observed[0].commandId).toBe(deterministicCommandId(state.tripId, 'event-1', 'request_plans'));
    expect(conversation.sent).toEqual([reply]);
    expect((await repository.loadTrip(state.tripId))?.revision).toBe(2);
    await runtime.stop();
    repository.close();
  });

  it('discards candidate research when the trip revision changes while research is in flight', async () => {
    const { repository, enrollment, state } = setup();
    const conversation = new FakeConversation();
    const researchStarted = deferred<void>();
    const finishResearch = deferred<TripCandidate[]>();
    let eventNumber = 0;
    conversation.parseInbound.mockImplementation(async (message) => command(message.eventId));
    const planner: PlannerAdapter = {
      applyCommand(current) {
        eventNumber += 1;
        return {
          state: { ...current, revision: current.revision + 1, status: eventNumber === 1 ? 'researching' : 'gathering' },
          replies: [],
          researchRequested: eventNumber === 1,
        };
      },
      generateCandidates: async () => {
        researchStarted.resolve();
        return finishResearch.promise;
      },
    };
    await repository.bootstrapTrip(enrollment, state);
    const runtime = createApplicationRuntime({ repository, conversation, planner, tripId: state.tripId });
    await runtime.start();
    await conversation.emit(inbound('event-plans'));
    await researchStarted.promise;
    await conversation.emit(inbound('event-constraint'));
    finishResearch.resolve([candidate(2)]);
    await runtime.stop();

    const finalState = await repository.loadTrip(state.tripId);
    expect(finalState?.revision).toBe(3);
    expect(finalState?.status).toBe('gathering');
    expect(finalState?.candidates).toEqual([]);
    expect(conversation.sent).toEqual([]);
    repository.close();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function candidate(revision: number): TripCandidate {
  return {
    candidateId: 'stale-candidate', revision, title: 'Old option', startAt: '2026-11-14T08:00:00-05:00', endAt: '2026-11-15T20:00:00-05:00',
    itinerary: [], costs: [], contingencyCents: 0, perPersonTotals: [], evidence: [], tradeoffs: [],
    feasibility: { feasible: true, violatedConstraints: [], unknownEssentials: [] },
  };
}
