import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationService, FinanceService, HouseholdConfig } from '../../src/contracts/index.js';
import { createApplicationRuntime } from '../../src/app/runtime.js';

const household: HouseholdConfig = {
  householdId: 'demo-house', groupSpaceId: 'space', designatedPayerId: 'mason', householdAccountId: 'house',
  members: [
    { userId: 'mason', displayName: 'Mason', providerUserId: 'p1', bankAccountId: 'b1' },
    { userId: 'alex', displayName: 'Alex', providerUserId: 'p2', bankAccountId: 'b2' },
    { userId: 'jordan', displayName: 'Jordan', providerUserId: 'p3', bankAccountId: 'b3' },
  ], recipients: [], demoCycles: [],
};
let stopRuntime: (() => Promise<void>) | undefined;
afterEach(async () => { await stopRuntime?.(); stopRuntime = undefined; });

describe('application runtime', () => {
  it('starts HTTP before provider intake, ticks finance tasks manually, and closes cleanly', async () => {
    const finance = {
      reconcile: vi.fn(async () => undefined), processReminders: vi.fn(async () => undefined),
      pendingMessages: vi.fn(async () => []), markDeliveryUncertain: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as FinanceService;
    const conversation: ConversationService = {
      parseInbound: vi.fn(async () => ({ kind: 'ignored' as const, reason: 'mock' })),
      sendMessage: vi.fn(async () => ({ providerMessageId: 'mock-1' })), stop: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    };
    const server = createServer((_req, res) => { res.end('ok'); });
    const runtime = createApplicationRuntime({ server, finance, conversation, household, port: 0, onError: vi.fn() });
    stopRuntime = runtime.stop;
    await runtime.start();
    expect(server.listening).toBe(true);
    expect(conversation.start).toHaveBeenCalledOnce();
    await runtime.runReconciliation();
    await runtime.runDelivery();
    await runtime.runReminders();
    expect(finance.reconcile).toHaveBeenCalledWith('demo-house');
    expect(finance.processReminders).toHaveBeenCalledWith('demo-house');
    await runtime.stop();
    stopRuntime = undefined;
    expect(conversation.stop).toHaveBeenCalledOnce();
    expect(finance.close).toHaveBeenCalledOnce();
  });
});

