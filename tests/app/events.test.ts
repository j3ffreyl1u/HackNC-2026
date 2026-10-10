import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ConversationService, FinanceService, InboundMessage, OutboundMessage, ParseResult } from '../../src/contracts/index.js';
import { createEventHandler, deterministicCommandId, drainOutbox } from '../../src/app/events.js';
import { UnknownActorError } from '../../src/finance/index.js';

const message = (eventId: string): InboundMessage => ({
  eventId, messageId: `message-${eventId}`, senderId: 'mason', spaceId: 'space',
  visibility: 'group', occurredAt: '2026-10-10T12:00:00.000Z', text: 'hello',
});

function financeStub(overrides: Partial<FinanceService> = {}): FinanceService {
  return {
    execute: vi.fn(), reconcile: vi.fn(), getSnapshot: vi.fn(), pendingMessages: vi.fn(async () => []),
    enqueueMessage: vi.fn(), recordDelivery: vi.fn(), lookupProposal: vi.fn(), advanceDemoCycle: vi.fn(),
    getConversationContext: vi.fn(), processReminders: vi.fn(), bootstrapHousehold: vi.fn(), seedDemoBanking: vi.fn(),
    claimInbound: vi.fn(async () => true), completeInbound: vi.fn(), close: vi.fn(), ...overrides,
  } as unknown as FinanceService;
}

function conversationStub(overrides: Partial<ConversationService> = {}): ConversationService {
  return {
    parseInbound: vi.fn(async (_input: InboundMessage): Promise<ParseResult> => ({ kind: 'ignored', reason: 'test' })),
    sendMessage: vi.fn(async () => ({ providerMessageId: 'provider-1' })),
    start: vi.fn(), stop: vi.fn(), ...overrides,
  };
}

describe('event composition', () => {
  it('derives stable command IDs from household, event and action', () => {
    const command = { householdId: 'demo-house', payload: { kind: 'approve' as const, proposalId: 'p1', proposalVersion: 1 } };
    expect(deterministicCommandId(command, 'evt-1')).toBe(deterministicCommandId(command, 'evt-1'));
    expect(deterministicCommandId(command, 'evt-1')).not.toBe(deterministicCommandId(command, 'evt-2'));
    expect(deterministicCommandId(command, 'evt-1')).not.toBe(deterministicCommandId({ ...command, householdId: 'other' }, 'evt-1'));
    expect(deterministicCommandId(command, 'evt-1')).not.toBe(deterministicCommandId({ ...command, payload: { kind: 'decline' as const, proposalId: 'p1', proposalVersion: 1 } }, 'evt-1'));
  });

  it('binds the executed command to the provider sender and event identity', async () => {
    const source = message('event-bound');
    const parsed = {
      commandId: 'model-provided-id', actorId: 'wrong-actor', householdId: 'demo-house', sourceEventId: 'wrong-event',
      payload: { kind: 'get_summary' as const, cycleId: '2026-10' },
    };
    const conversation = conversationStub({ parseInbound: vi.fn(async () => ({ kind: 'command' as const, command: parsed })) });
    const finance = financeStub({ execute: vi.fn(async () => ({ kind: 'accepted' as const })), markDeliveryUncertain: vi.fn(async () => undefined) });

    await createEventHandler(conversation, finance, 'demo-house')(source);

    expect(finance.execute).toHaveBeenCalledWith({
      ...parsed, commandId: deterministicCommandId(parsed, source.eventId), actorId: source.senderId, sourceEventId: source.eventId,
    });
    expect(finance.completeInbound).toHaveBeenCalledWith(source.eventId);
  });

  it('delivers a rejected command userMessage privately to the enrolled actor', async () => {
    const source = message('rejected-event');
    const command = {
      commandId: 'any', actorId: source.senderId, householdId: 'demo-house', sourceEventId: source.eventId,
      payload: { kind: 'approve' as const, proposalId: 'p1', proposalVersion: 1 },
    };
    const queued: OutboundMessage[] = [];
    const conversation = conversationStub({
      parseInbound: vi.fn(async () => ({ kind: 'command' as const, command })),
      sendMessage: vi.fn(async () => ({ providerMessageId: 'private-rejection-1' })),
    });
    const finance = financeStub({
      execute: vi.fn(async () => ({ kind: 'rejected' as const, code: 'STALE_PROPOSAL' as const, userMessage: 'Please approve the latest proposal.' })),
      enqueueMessage: vi.fn(async (message) => { queued.push(message); }),
      pendingMessages: vi.fn(async () => [...queued]),
      recordDelivery: vi.fn(async (deliveryId) => { const index = queued.findIndex((item) => item.deliveryId === deliveryId); if (index >= 0) queued.splice(index, 1); }),
      markDeliveryUncertain: vi.fn(async () => undefined),
    });

    await createEventHandler(conversation, finance, 'demo-house')(source);

    expect(finance.enqueueMessage).toHaveBeenCalledWith(expect.objectContaining({
      householdId: 'demo-house', audience: { kind: 'private', userId: source.senderId },
      text: 'Please approve the latest proposal.',
    }));
    expect(conversation.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      audience: { kind: 'private', userId: source.senderId }, text: 'Please approve the latest proposal.',
    }));
    expect(finance.recordDelivery).toHaveBeenCalledWith(expect.stringMatching(/^delivery-/), 'private-rejection-1');
    expect(finance.completeInbound).toHaveBeenCalledWith(source.eventId);
  });

  it('ignores Finance UnknownActorError without exposing an error or making a transfer', async () => {
    const source = message('unknown-actor-event');
    const command = {
      commandId: 'any', actorId: source.senderId, householdId: 'demo-house', sourceEventId: source.eventId,
      payload: { kind: 'get_summary' as const, cycleId: '2026-10' },
    };
    const conversation = conversationStub({ parseInbound: vi.fn(async () => ({ kind: 'command' as const, command })) });
    const finance = financeStub({ execute: vi.fn(async () => { throw new UnknownActorError(source.senderId); }) });

    await createEventHandler(conversation, finance, 'demo-house')(source);

    expect(finance.completeInbound).toHaveBeenCalledWith(source.eventId);
    expect(finance.enqueueMessage).not.toHaveBeenCalled();
    expect(finance.pendingMessages).not.toHaveBeenCalled();
  });

  it('completes but ignores a command for a different household', async () => {
    const source = message('wrong-household-event');
    const command = {
      commandId: 'any', actorId: source.senderId, householdId: 'other-house', sourceEventId: source.eventId,
      payload: { kind: 'get_summary' as const, cycleId: '2026-10' },
    };
    const conversation = conversationStub({ parseInbound: vi.fn(async () => ({ kind: 'command' as const, command })) });
    const finance = financeStub();

    await createEventHandler(conversation, finance, 'demo-house')(source);

    expect(finance.execute).not.toHaveBeenCalled();
    expect(finance.completeInbound).toHaveBeenCalledWith(source.eventId);
  });

  it('uses stable fixture event IDs to ignore provider retries before reparsing', async () => {
    const events = JSON.parse(await readFile(resolve('tests/fixtures/events.json'), 'utf8')) as InboundMessage[];
    const fixtureEvent = events[0];
    expect(events).toHaveLength(3);
    expect(events[1].visibility).toBe('private');
    expect(events[2].reaction?.emoji).toBe(String.fromCodePoint(0x1f44d));
    const conversation = conversationStub();
    const finance = financeStub({ claimInbound: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) });
    const handle = createEventHandler(conversation, finance);

    await handle(fixtureEvent);
    await handle(fixtureEvent);

    expect(finance.claimInbound).toHaveBeenNthCalledWith(1, fixtureEvent.eventId);
    expect(finance.claimInbound).toHaveBeenNthCalledWith(2, fixtureEvent.eventId);
    expect(conversation.parseInbound).toHaveBeenCalledTimes(1);
    expect(finance.completeInbound).toHaveBeenCalledTimes(1);
  });

  it('serializes inbound messages through parsing and finance handling', async () => {
    const parseStarted: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const conversation = conversationStub({ parseInbound: vi.fn(async (input: InboundMessage): Promise<ParseResult> => {
      parseStarted.push(input.eventId);
      if (input.eventId === 'one') await firstGate;
      return { kind: 'ignored', reason: 'test' };
    }) });
    const finance = financeStub();
    const handle = createEventHandler(conversation, finance);
    const first = handle(message('one'));
    const second = handle(message('two'));
    await vi.waitFor(() => expect(parseStarted).toEqual(['one']));
    releaseFirst();
    await Promise.all([first, second]);
    expect(parseStarted).toEqual(['one', 'two']);
    expect(finance.completeInbound).toHaveBeenCalledTimes(2);
  });

  it('marks an uncertain send and stops instead of retrying it blindly', async () => {
    const queued: OutboundMessage = { deliveryId: 'delivery-1', householdId: 'demo-house', audience: { kind: 'group', spaceId: 'space' }, text: 'proposal' };
    const finance = financeStub({ pendingMessages: vi.fn(async (): Promise<OutboundMessage[]> => [queued]), markDeliveryUncertain: vi.fn(async () => undefined) });
    const conversation = conversationStub({ sendMessage: vi.fn(async () => { throw new Error('provider timeout'); }) });
    await expect(drainOutbox(conversation, finance)).rejects.toThrow('provider timeout');
    expect(finance.markDeliveryUncertain).toHaveBeenCalledWith('delivery-1');
    expect(conversation.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('quarantines a delivery in-process if persisting uncertainty fails', async () => {
    const queued: OutboundMessage = { deliveryId: 'delivery-db-error', householdId: 'demo-house', audience: { kind: 'group', spaceId: 'space' }, text: 'proposal' };
    const finance = financeStub({ pendingMessages: vi.fn(async (): Promise<OutboundMessage[]> => [queued]), markDeliveryUncertain: vi.fn(async () => { throw new Error('database unavailable'); }) });
    const conversation = conversationStub({ sendMessage: vi.fn(async () => { throw new Error('provider timeout'); }) });
    await expect(drainOutbox(conversation, finance)).rejects.toThrow('database unavailable');
    await expect(drainOutbox(conversation, finance)).resolves.toBeUndefined();
    expect(conversation.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('does not send when durable uncertainty handling is unavailable', async () => {
    const queued: OutboundMessage = { deliveryId: 'd', householdId: 'h', audience: { kind: 'group', spaceId: 's' }, text: 'x' };
    const finance = financeStub({ pendingMessages: vi.fn(async (): Promise<OutboundMessage[]> => [queued]) });
    const conversation = conversationStub();
    await expect(drainOutbox(conversation, finance)).rejects.toThrow('durable markDeliveryUncertain');
    expect(conversation.sendMessage).not.toHaveBeenCalled();
  });
});

