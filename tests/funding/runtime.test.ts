import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { approved } from './fixture.js';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { createFundService } from '../../src/funding/service.js';
import { createApplicationRuntime } from '../../src/app/runtime.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';
import type { ConversationService, OutboundMessage, InboundMessage } from '../../src/contracts/index.js';

it('persists warning keys with the outbox and does not repeat a notice after reopening SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fund-runtime-'));
  const path = join(dir, 'trip.sqlite');
  let repository = SqliteTripRepository.open(path);
  const { enrollment } = await loadDemoTrip('tests/fixtures/trip.json');
  const state = await approved();
  const sent: OutboundMessage[] = [];
  const conversation: ConversationService = {
    start: async () => {}, stop: async () => {}, sendMessage: async message => { sent.push(message); return [{ providerMessageId: message.deliveryId }]; },
    parseInbound: async message => ({ kind: 'command', command: { commandId: message.eventId, eventId: message.eventId, tripId: state.tripId, actorId: message.senderId, action: { kind: 'request_funding' } } }),
  };
  const fundService = createFundService({ read: async () => ({ deposits: [], purchases: [{ id: 'purchase', amountDollars: 100, category: 'hotel', status: 'completed' }] }) }, 'mock');
  const planner = { applyCommand: (current: typeof state) => ({ state: current, replies: [], researchRequested: false }), generateCandidates: async () => [] };
  const event = (id: string): InboundMessage => ({ eventId: id, messageId: id, senderId: enrollment.participants[0].memberId, spaceId: enrollment.groupSpaceId, visibility: 'group', occurredAt: '2026-10-10T12:00:00Z', text: "how's the fund?" });
  let runtime = createApplicationRuntime({ repository, conversation, planner, tripId: state.tripId, fundService });
  try {
    await repository.bootstrapTrip(enrollment, state);
    await runtime.start();
    await runtime.handleInbound(event('first'));
    expect((await repository.loadTrip(state.tripId))?.fundingNoticeKeys?.[String(state.revision)]).toEqual(['accommodation:near']);
    expect(sent.filter(m => m.text.startsWith('Heads up:'))).toHaveLength(1);
    expect((await repository.getPublicSnapshot(state.tripId)) as object).not.toHaveProperty('fundingNoticeKeys');
    await runtime.stop(); repository.close();
    repository = SqliteTripRepository.open(path);
    runtime = createApplicationRuntime({ repository, conversation, planner, tripId: state.tripId, fundService });
    await runtime.start();
    await runtime.handleInbound(event('second'));
    expect(sent.filter(m => m.text.startsWith('Heads up:'))).toHaveLength(1);
  } finally { await runtime.stop(); repository.close(); await rm(dir, { recursive: true, force: true }); }
});
