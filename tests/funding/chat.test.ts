import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approved } from './fixture.js';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { createApplicationRuntime } from '../../src/app/runtime.js';
import { createFundService } from '../../src/funding/service.js';
import { depositTag } from '../../src/planning/funding.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';
import type { ConversationService, InboundMessage, OutboundMessage } from '../../src/contracts/index.js';

type Topic = 'status' | 'remind' | 'wrap_up';

async function chat(options: { deposits?: Array<{ id: string; amountDollars: number; description: string; status: string }>; purchases?: Array<{ id: string; amountDollars: number; category: string; status: string }> }) {
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
  const fundService = createFundService({ read: async () => ({ deposits: options.deposits ?? [], purchases: options.purchases ?? [] }) }, 'mock');
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
const paid = (id: string, dollars: number) => ({ id: `dep-${id}`, amountDollars: dollars, description: depositTag(id, 1), status: 'completed' });

describe('fund chat', () => {
  it('answers a fund question privately in three short lines, with no budget or cap in it', async () => {
    const t = await chat({ deposits: [paid('mason', 45)] });
    const out = await t.say('e1', 'status');
    const answer = out.find((m) => m.audience.kind === 'private');
    expect(answer).toBeDefined();
    expect(answer!.audience).toMatchObject({ kind: 'private', memberId: t.requester });
    expect(lines(answer!.text).length).toBeLessThanOrEqual(3);
    for (const m of out) expect(m.text).not.toMatch(/20000|25000|30000|\$200\b|\$250\b|\$300\b|budget|cap\b/i);
    await t.stop();
  });

  it('sends each notice on its own, one per message, instead of all at once', async () => {
    const t = await chat({ purchases: [{ id: 'p1', amountDollars: 100, category: 'hotel', status: 'completed' }, { id: 'p2', amountDollars: 20, category: 'gas', status: 'completed' }] });
    const notices = (out: OutboundMessage[]) => out.filter((m) => /simulated sandbox money/.test(m.text));
    expect(notices(await t.say('e1', 'status'))).toHaveLength(1);
    expect(notices(await t.say('e2', 'status'))).toHaveLength(1);
    expect(notices(await t.say('e3', 'status'))).toHaveLength(0);
    await t.stop();
  });

  it('reminds only the people who still owe, each privately about their own share, and tells the asker who it nudged', async () => {
    const t = await chat({ deposits: [paid('mason', 45)] });
    const out = await t.say('e1', 'remind');
    const reminders = out.filter((m) => /^Your share/.test(m.text) && m.audience.kind === 'private' && m.audience.memberId !== 'mason');
    const targets = reminders.map((m) => (m.audience.kind === 'private' ? m.audience.memberId : 'group')).sort();
    expect(targets).toEqual(t.members.filter((id) => id !== 'mason').sort());
    for (const m of reminders) {
      expect(m.audience.kind).toBe('private');
      expect(m.text).toMatch(/Your share/);
      expect(lines(m.text).length).toBeLessThanOrEqual(3);
    }
    const toAsker = out.find((m) => m.audience.kind === 'private' && m.audience.memberId === 'mason' && /Reminded/.test(m.text));
    expect(toAsker?.text).toMatch(/Alex/);
    expect(toAsker?.text).not.toMatch(/\$/);
    await t.stop();
  });

  it('when the asker owes too, tells them about their own share once, in the same message', async () => {
    const t = await chat({ deposits: [paid('mason', 45)] });
    const out = await t.say('e1', 'remind', 'alex');
    const toAlex = out.filter((m) => m.audience.kind === 'private' && m.audience.memberId === 'alex');
    expect(toAlex.filter((m) => /Your share/.test(m.text))).toHaveLength(1);
    expect(toAlex[0]!.text).toMatch(/Reminded Jordan/);
    const toJordan = out.filter((m) => m.audience.kind === 'private' && m.audience.memberId === 'jordan' && /Your share/.test(m.text));
    expect(toJordan).toHaveLength(1);
    await t.stop();
  });

  it('says so when nobody owes anything, and sends no reminders', async () => {
    const t = await chat({ deposits: t_all(['mason', 'alex', 'jordan']) });
    const out = await t.say('e1', 'remind');
    expect(out.filter((m) => /^Your share/.test(m.text))).toHaveLength(0);
    expect(out.some((m) => /covered|everyone/i.test(m.text))).toBe(true);
    await t.stop();
  });

  it('sends the wrap-up to the group in three short lines and says the bot moves nothing', async () => {
    const t = await chat({ deposits: t_all(['mason', 'alex', 'jordan']), purchases: [{ id: 'p1', amountDollars: 90, category: 'hotel', status: 'completed' }] });
    const out = await t.say('e1', 'wrap_up');
    const wrap = out.find((m) => /wrap-up/i.test(m.text));
    expect(wrap).toBeDefined();
    expect(wrap!.audience.kind).toBe('group');
    expect(lines(wrap!.text).length).toBeLessThanOrEqual(3);
    expect(wrap!.text).toMatch(/don't move any money/i);
    expect(wrap!.text).not.toMatch(/budget|cap\b/i);
    await t.stop();
  });
});

function t_all(ids: string[]) { return ids.map((id) => paid(id, 45)); }
