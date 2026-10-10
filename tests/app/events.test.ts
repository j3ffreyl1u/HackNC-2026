import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ConversationService, FinanceService, InboundMessage, OutboundMessage, ParseResult } from '../../src/contracts/index.js';
import { createEventHandler, drainOutbox } from '../../src/app/events.js';

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

