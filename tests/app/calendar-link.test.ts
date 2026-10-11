import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { createApplicationRuntime } from '../../src/app/runtime.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';
import type { ConversationService, InboundMessage, OutboundMessage } from '../../src/contracts/index.js';

async function run(calendarUrl?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'cal-link-'));
  const repository = SqliteTripRepository.open(join(dir, 'trip.sqlite'));
  const { enrollment, state } = await loadDemoTrip('tests/fixtures/trip.json');
  const sent: OutboundMessage[] = [];
  const conversation: ConversationService = {
    start: async () => {}, stop: async () => {}, sendMessage: async (m) => { sent.push(m); return [{ providerMessageId: m.deliveryId }]; },
    parseInbound: async (m) => ({ kind: 'command', command: { commandId: m.eventId, eventId: m.eventId, tripId: state.tripId, actorId: m.senderId, action: { kind: 'request_plans' } } }),
  };
  const planner = {
    applyCommand: (current: typeof state) => ({ state: current, researchRequested: false, replies: [{ audience: { kind: 'group' as const, spaceId: enrollment.groupSpaceId }, deliveryId: 'x', text: "Everyone's in, so the park weekend is approved.\nAdd it to your calendar: {{CALENDAR_LINK}}" }] }),
    generateCandidates: async () => [],
  };
  const runtime = createApplicationRuntime({ repository, conversation, planner, tripId: state.tripId, ...(calendarUrl ? { calendarUrl } : {}) });
  await repository.bootstrapTrip(enrollment, state);
  await runtime.start();
  const event: InboundMessage = { eventId: 'e1', messageId: 'e1', senderId: enrollment.participants[0]!.memberId, spaceId: enrollment.groupSpaceId, visibility: 'group', occurredAt: '2026-10-10T12:00:00Z', text: 'x' };
  await runtime.handleInbound(event);
  await runtime.stop(); repository.close(); await rm(dir, { recursive: true, force: true });
  return sent.map((m) => m.text).join('\n---\n');
}

describe('calendar link in the approval message', () => {
  it('puts the real address in', async () => {
    const text = await run('https://example.test/api/trips/t/plan.ics');
    expect(text).toContain('Add it to your calendar: https://example.test/api/trips/t/plan.ics');
    expect(text).not.toContain('{{');
  });

  it('leaves the calendar line out entirely when there is no address, never a dangling token', async () => {
    const text = await run();
    expect(text).toContain('is approved.');
    expect(text).not.toMatch(/calendar|\{\{/i);
  });
});
