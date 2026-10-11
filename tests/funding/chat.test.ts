import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approved } from './fixture.js';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { createApplicationRuntime } from '../../src/app/runtime.js';
import { createFundService } from '../../src/funding/service.js';
import type { Purchase } from '../../src/planning/funding.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';
import type { ConversationService, InboundMessage, OutboundMessage } from '../../src/contracts/index.js';

type Topic = 'status' | 'remind' | 'wrap_up';

async function chat(options: { purchases?: Purchase[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fund-chat-'));
  const repository = SqliteTripRepository.open(join(dir, 'trip.sqlite'));
  const { enrollment } = await loadDemoTrip('tests/fixtures/trip.json');
  const state = await approved();
  const sent: OutboundMessage[] = [];
  const topics = new Map<string, Topic>();
  const conversation: ConversationService = {
    start: async () => {}, stop: async () => {}, sendMessage: async (m) => { sent.push(m); return [{ providerMessageId: m.deliveryId }]; },
    parseInbound: async (m) => ({ kind: 'command', command: { commandId: m.eventId, eventId: m.eventId, tripId: state.tripId, actorId: m.senderId, action: { kind: 'request_funding', topic: topics.get(m.eventId) ?? 'status' } } }),
  };
  const fundService = createFundService({ read: async () => ({ purchases: options.purchases ?? [] }) }, 'mock');
  const planner = { applyCommand: (current: typeof state) => ({ state: current, replies: [], researchRequested: false }), generateCandidates: async () => [] };
  const runtime = createApplicationRuntime({ repository, conversation, planner, tripId: state.tripId, fundService });
  await repository.bootstrapTrip(enrollment, state);
  await runtime.start();
  const requester = enrollment.participants[0]!.memberId;
  const say = async (eventId: string, topic: Topic, from = requester) => {
    topics.set(eventId, topic);
    const before = sent.length;
    const event: InboundMessage = { eventId, messageId: eventId, senderId: from, spaceId: enrollment.groupSpaceId, visibility: 'group', occurredAt: '2026-10-10T12:00:00Z', text: 'x' };
    await runtime.handleInbound(event);
    return sent.slice(before);
  };
  const names = new Map(enrollment.participants.map((p) => [p.memberId, p.displayName]));
  const stop = async () => { await runtime.stop(); repository.close(); await rm(dir, { recursive: true, force: true }); };
  return { say, stop, requester, members: enrollment.participants.map((p) => p.memberId), names };
}
const lines = (text: string) => text.split('\n').filter((l) => l.trim() !== '');
const buy = (memberId: string, amountDollars: number, category: string): Purchase => ({ id: `${memberId}-${category}-${amountDollars}`, memberId, amountDollars, category, status: 'completed' });

describe('fund chat (who covered what)', () => {
  it('answers privately in three short lines, says who covered what, and has no budget or cap in it', async () => {
    const t = await chat({ purchases: [buy('mason', 60, 'gas')] });
    const out = await t.say('e1', 'status');
    const answer = out.find((m) => m.audience.kind === 'private' && /Covered so far/.test(m.text));
    expect(answer).toBeDefined();
    expect(answer!.audience).toMatchObject({ kind: 'private', memberId: t.requester });
    expect(answer!.text).toMatch(/Mason \$60/); expect(answer!.text).toMatch(/Alex owes Mason \$20/); expect(answer!.text).toMatch(/Simulated money/);
    expect(lines(answer!.text).length).toBeLessThanOrEqual(3);
    for (const m of out) expect(m.text).not.toMatch(/20000|25000|30000|\$200\b|\$250\b|\$300\b|your max|\bcap\b/i);
    await t.stop();
  });

  it('sends each notice on its own, one per message, instead of all at once', async () => {
    const t = await chat({ purchases: [buy('mason', 100, 'hotel'), buy('mason', 20, 'gas')] });
    const notices = (out: OutboundMessage[]) => out.filter((m) => /simulated sandbox money/.test(m.text));
    expect(notices(await t.say('e1', 'status'))).toHaveLength(1);
    expect(notices(await t.say('e2', 'status'))).toHaveLength(1);
    expect(notices(await t.say('e3', 'status'))).toHaveLength(0);
    await t.stop();
  });

  it('settle-up reminders go only to people who owe, each privately about their own debt, and the asker is told who was nudged', async () => {
    const t = await chat({ purchases: [buy('mason', 90, 'hotel')] });
    const out = await t.say('e1', 'remind');
    const reminders = out.filter((m) => /^Settling up/.test(m.text));
    const targets = reminders.map((m) => (m.audience.kind === 'private' ? m.audience.memberId : 'group')).sort();
    expect(targets).toEqual(['alex', 'jordan']);
    for (const m of reminders) { expect(m.audience.kind).toBe('private'); expect(m.text).toMatch(/you owe Mason \$30/i); expect(m.text).not.toMatch(/Jordan|Alex/); }
    const toAsker = out.find((m) => m.audience.kind === 'private' && m.audience.memberId === 'mason' && /Reminded/.test(m.text));
    expect(toAsker?.text).toMatch(/Alex and Jordan/); expect(toAsker?.text).not.toMatch(/\$/);
    await t.stop();
  });

  it('when the asker owes too, tells them about their own debt once, in the same message', async () => {
    const t = await chat({ purchases: [buy('mason', 90, 'hotel')] });
    const out = await t.say('e1', 'remind', 'alex');
    const toAlex = out.filter((m) => m.audience.kind === 'private' && m.audience.memberId === 'alex');
    expect(toAlex.filter((m) => /Settling up/.test(m.text))).toHaveLength(1);
    expect(toAlex[0]!.text).toMatch(/Reminded Jordan/);
    expect(out.filter((m) => m.audience.kind === 'private' && m.audience.memberId === 'jordan' && /Settling up/.test(m.text))).toHaveLength(1);
    await t.stop();
  });

  it('says so when nobody owes anything, and sends no reminders', async () => {
    const t = await chat({ purchases: [buy('mason', 30, 'gas'), buy('alex', 30, 'gas'), buy('jordan', 30, 'gas')] });
    const out = await t.say('e1', 'remind');
    expect(out.filter((m) => /^Settling up/.test(m.text))).toHaveLength(0);
    expect(out.some((m) => /nobody to remind/i.test(m.text))).toBe(true);
    await t.stop();
  });

  it('the wrap-up goes to the group: who sends whom, and that the bot moves nothing', async () => {
    const t = await chat({ purchases: [buy('mason', 90, 'hotel')] });
    const out = await t.say('e1', 'wrap_up');
    const wrap = out.find((m) => /wrap-up/i.test(m.text));
    expect(wrap).toBeDefined();
    expect(wrap!.audience.kind).toBe('group');
    expect(lines(wrap!.text).length).toBeLessThanOrEqual(4);
    expect(wrap!.text).toMatch(/Alex sends Mason \$30/); expect(wrap!.text).toMatch(/Jordan sends Mason \$30/);
    expect(wrap!.text).toMatch(/don't move any money/i);
    expect(wrap!.text).not.toMatch(/budget|cap\b/i);
    await t.stop();
  });
});
