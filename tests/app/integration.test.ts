import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command, ConversationService, FinanceService, HouseholdConfig, HouseholdSnapshot, InboundMessage, OutboundMessage } from '../../src/contracts/index.js';
import { createApplicationRuntime } from '../../src/app/runtime.js';
import { createAppServer } from '../../src/app/server.js';

const household: HouseholdConfig = {
  householdId: 'demo-house', groupSpaceId: 'mock-space', designatedPayerId: 'mason', householdAccountId: 'mock-household',
  members: [
    { userId: 'mason', displayName: 'Mason', providerUserId: 'mock-mason', bankAccountId: 'bank-mason' },
    { userId: 'alex', displayName: 'Alex', providerUserId: 'mock-alex', bankAccountId: 'bank-alex' },
    { userId: 'jordan', displayName: 'Jordan', providerUserId: 'mock-jordan', bankAccountId: 'bank-jordan' },
  ],
  recipients: [{ recipientId: 'electric', displayName: 'Electricity Provider', bankAccountId: 'bank-electric' }],
  demoCycles: [{ cycleId: '2026-10', bills: [{ title: 'Electricity', amountCents: 14400, dueDate: '2026-10-15', recipientId: 'electric' }] }],
};

const snapshot: HouseholdSnapshot = {
  householdId: 'demo-house', cycleId: '2026-10', currency: 'USD', balanceCents: 4800,
  bills: [{ billId: 'bill-october-electric', title: 'Electricity', amountCents: 14400, dueDate: '2026-10-15', status: 'collecting' }],
  contributions: [{ billId: 'bill-october-electric', userId: 'mason', agreedCents: 4800, confirmedCents: 4800 }],
  debts: [], activity: [{ activityId: 'activity-mason-payment', occurredAt: '2026-10-10T12:05:00.000Z', description: 'Mason contribution confirmed', status: 'confirmed' }],
};

let stopRuntime: (() => Promise<void>) | undefined;
afterEach(async () => { await stopRuntime?.(); stopRuntime = undefined; });

describe('app integration with contract fakes', () => {
  it('routes fixture intake through Finance, delivers its outbox, and serves the public ledger snapshot', async () => {
    const [inbound] = JSON.parse(await readFile(resolve('tests/fixtures/events.json'), 'utf8')) as InboundMessage[];
    const command: Command = {
      commandId: 'cmd-october-summary', actorId: inbound.senderId, householdId: household.householdId,
      sourceEventId: inbound.eventId, payload: { kind: 'get_summary', cycleId: '2026-10' },
    };
    const outbound: OutboundMessage = {
      deliveryId: 'delivery-october-summary', householdId: household.householdId,
      audience: { kind: 'group', spaceId: household.groupSpaceId }, text: 'October electricity: $144.00.',
    };
    const queued: OutboundMessage[] = [];
    let receive!: (event: InboundMessage) => Promise<void>;
    const conversation: ConversationService = {
      parseInbound: vi.fn(async () => ({ kind: 'command' as const, command })),
      sendMessage: vi.fn(async () => ({ providerMessageId: 'provider-summary-1' })),
      start: vi.fn(async (onMessage) => { receive = onMessage; }), stop: vi.fn(async () => undefined),
    };
    const finance = {
      claimInbound: vi.fn(async () => true), completeInbound: vi.fn(async () => undefined),
      execute: vi.fn(async () => { queued.push(outbound); return { kind: 'accepted' as const }; }),
      enqueueMessage: vi.fn(async () => undefined), pendingMessages: vi.fn(async () => [...queued]),
      recordDelivery: vi.fn(async (deliveryId: string) => { const index = queued.findIndex((message) => message.deliveryId === deliveryId); if (index >= 0) queued.splice(index, 1); }),
      markDeliveryUncertain: vi.fn(async () => undefined), reconcile: vi.fn(async () => undefined),
      processReminders: vi.fn(async () => undefined), getSnapshot: vi.fn(async () => snapshot),
      close: vi.fn(async () => undefined),
    } as unknown as FinanceService;
    const server = createAppServer({ finance, config: household, demoMode: true });
    const runtime = createApplicationRuntime({ server, conversation, finance, household, port: 0, onError: vi.fn() });
    stopRuntime = runtime.stop;

    await runtime.start();
    await receive(inbound);
    await runtime.runDelivery();

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server has no local address');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/households/demo-house/snapshot`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(finance.claimInbound).toHaveBeenCalledWith(inbound.eventId);
    expect(conversation.parseInbound).toHaveBeenCalledWith(inbound);
    expect(finance.execute).toHaveBeenCalledWith(command);
    expect(finance.completeInbound).toHaveBeenCalledWith(inbound.eventId);
    expect(conversation.sendMessage).toHaveBeenCalledWith(outbound);
    expect(finance.recordDelivery).toHaveBeenCalledWith(outbound.deliveryId, 'provider-summary-1');
    expect(queued).toHaveLength(0);
  });
});
