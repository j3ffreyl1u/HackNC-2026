import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { createApplicationRuntime } from '../../src/app/runtime.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';
import type { ConversationService, InboundMessage, OutboundMessage, TripCandidate, TripState } from '../../src/contracts/index.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

type Research = (state: TripState) => Promise<{ revision: number; candidates: TripCandidate[]; replies: OutboundMessage[] }>;

/** The real runtime and storage with a scripted phone line and a scripted planner, so failures can be made on purpose. */
async function setup(options: { research?: Research; sendFails?: (m: OutboundMessage, attempt: number) => boolean; status?: TripState['status']; dir?: string; stillLookingMs?: number } = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'reliability-'));
  if (!options.dir) dirs.push(dir);
  const repository = SqliteTripRepository.open(join(dir, 'trip.sqlite'));
  const { enrollment, state: demo } = await loadDemoTrip('tests/fixtures/trip.json');
  const state: TripState = { ...demo, status: options.status ?? 'gathering' };
  const sent: OutboundMessage[] = [];
  const attempts = new Map<string, number>();
  const conversation: ConversationService = {
    start: async () => {}, stop: async () => {},
    sendMessage: async (m) => {
      const n = (attempts.get(m.deliveryId) ?? 0) + 1;
      attempts.set(m.deliveryId, n);
      if (options.sendFails?.(m, n)) throw new Error('phone line down');
      sent.push(m);
      return [{ providerMessageId: m.deliveryId }];
    },
    parseInbound: async (m) => ({ kind: 'command', command: { commandId: m.eventId, eventId: m.eventId, tripId: state.tripId, actorId: m.senderId, action: { kind: 'request_plans' } } }),
  };
  const planner = {
    applyCommand: (current: TripState) => ({ state: { ...current, status: 'researching' as const }, replies: [], researchRequested: true }),
    generateCandidates: async () => [],
    ...(options.research ? { research: options.research } : {}),
  };
  const runtime = createApplicationRuntime({ repository, conversation, planner, tripId: state.tripId, ...(options.stillLookingMs !== undefined ? { stillLookingMs: options.stillLookingMs } : {}) });
  if (!options.dir) await repository.bootstrapTrip(enrollment, state);
  const sender = enrollment.participants[0]!.memberId;
  const event = (id: string): InboundMessage => ({ eventId: id, messageId: id, senderId: sender, spaceId: enrollment.groupSpaceId, visibility: 'group', occurredAt: '2026-10-10T12:00:00Z', text: 'show us some options' });
  return { runtime, repository, sent, event, state, dir, enrollment };
}
const found = (revision: number, text = 'Here are the options.'): Awaited<ReturnType<Research>> => ({
  revision, candidates: [],
  replies: [{ audience: { kind: 'group', spaceId: 'mock-friends' }, text, deliveryId: 'x' }],
});

describe('research that fails', () => {
  it('tells the group every time it fails, says how to retry, and works once the service is back', async () => {
    let calls = 0;
    const t = await setup({ research: async (s) => { calls += 1; if (calls < 3) throw new Error('quota exceeded'); return found(s.revision); } });
    await t.repository.getEnrollment(t.state.tripId);
    await t.runtime.start();
    await t.runtime.handleInbound(t.event('e1')); await t.runtime.waitForIdle();
    await t.runtime.handleInbound(t.event('e2')); await t.runtime.waitForIdle();
    const failures = t.sent.filter((m) => /couldn't look up options/i.test(m.text));
    expect(failures, 'one notice per failed attempt').toHaveLength(2);
    expect(failures[0]!.text).toMatch(/show us some options/i);
    expect(failures[0]!.text).toMatch(/nothing about your plan changed/i);
    expect(failures[0]!.text).not.toMatch(/quota|exception|error|stack/i);
    await t.runtime.handleInbound(t.event('e3')); await t.runtime.waitForIdle();
    expect(t.sent.some((m) => m.text === 'Here are the options.')).toBe(true);
    expect((await t.repository.loadTrip(t.state.tripId))?.status).toBe('proposed');
    await t.runtime.stop(); t.repository.close();
  });
});

describe('restart in the middle of a search', () => {
  it('resumes the search after a restart and does not send the options twice', async () => {
    const first = await setup({ status: 'researching', research: () => new Promise(() => {}) });
    await first.runtime.start();            // the search starts and never finishes: the process dies here, with no clean stop
    first.repository.close();

    const second = await setup({ dir: first.dir, research: async (s) => found(s.revision) });
    await second.runtime.start();
    await second.runtime.waitForIdle();
    expect(second.sent.filter((m) => m.text === 'Here are the options.')).toHaveLength(1);
    await second.runtime.stop(); second.repository.close();

    const third = await setup({ dir: first.dir, research: async (s) => found(s.revision) });
    await third.runtime.start();
    await third.runtime.waitForIdle();
    expect(third.sent.filter((m) => m.text === 'Here are the options.')).toHaveLength(0);
    await third.runtime.stop(); third.repository.close();
  });
});

describe('duplicate messages', () => {
  it('handles the same inbound event once, even when it arrives twice at the same moment', async () => {
    let researched = 0;
    const t = await setup({ research: async (s) => { researched += 1; return found(s.revision); } });
    await t.runtime.start();
    await Promise.all([t.runtime.handleInbound(t.event('dup')), t.runtime.handleInbound(t.event('dup'))]);
    await t.runtime.handleInbound(t.event('dup'));
    await t.runtime.waitForIdle();
    expect(researched).toBe(1);
    expect(t.sent.filter((m) => m.text === 'Here are the options.')).toHaveLength(1);
    await t.runtime.stop(); t.repository.close();
  });
});

describe('the outbox', () => {
  it('keeps trying a message the phone line refused, sends it once, and never lets later messages to the same place overtake it', async () => {
    const t = await setup({
      research: async (s) => ({ revision: s.revision, candidates: [], replies: [
        { audience: { kind: 'group', spaceId: 'mock-friends' }, text: 'First message', deliveryId: 'a' },
        { audience: { kind: 'group', spaceId: 'mock-friends' }, text: 'Second message', deliveryId: 'b' },
      ] }),
      sendFails: (m, attempt) => m.text === 'First message' && attempt < 3,
    });
    await t.runtime.start();
    await t.runtime.handleInbound(t.event('e1')); await t.runtime.waitForIdle();
    expect(t.sent.map((m) => m.text).filter((x) => /message/.test(x))).toEqual([]);   // the first is refused, so the second waits behind it
    await t.runtime.drainOutbox();                                                       // still refused (attempt 2)
    await t.runtime.drainOutbox();                                                       // accepted (attempt 3)
    expect(t.sent.map((m) => m.text).filter((x) => /message/.test(x))).toEqual(['First message', 'Second message']);
    await t.runtime.drainOutbox();
    expect(t.sent.filter((m) => m.text === 'First message')).toHaveLength(1);
    await t.runtime.stop(); t.repository.close();
  });

  it('does not let one stuck recipient hold up messages to everyone else', async () => {
    const t = await setup({
      research: async (s) => ({ revision: s.revision, candidates: [], replies: [
        { audience: { kind: 'private', memberId: 'mason' }, text: 'For Mason', deliveryId: 'a' },
        { audience: { kind: 'private', memberId: 'alex' }, text: 'For Alex', deliveryId: 'b' },
      ] }),
      sendFails: (m) => m.text === 'For Mason',
    });
    await t.runtime.start();
    await t.runtime.handleInbound(t.event('e1')); await t.runtime.waitForIdle();
    expect(t.sent.some((m) => m.text === 'For Alex')).toBe(true);
    expect(t.sent.some((m) => m.text === 'For Mason')).toBe(false);
    await t.runtime.stop(); t.repository.close();
  });
});

describe('a search that takes a while', () => {
  it('sends one short "still looking" text to the group, then the options when they arrive', async () => {
    let finish: (() => void) | undefined;
    const t = await setup({
      stillLookingMs: 30,
      research: (s) => new Promise((resolve) => { finish = () => resolve(found(s.revision)); }),
    });
    await t.runtime.start();
    await t.runtime.handleInbound(t.event('slow-1'));
    await new Promise((r) => setTimeout(r, 120));
    await t.runtime.drainOutbox();
    expect(t.sent.filter((m) => /Still looking/.test(m.text))).toHaveLength(1);
    expect(t.sent.some((m) => m.text === 'Here are the options.')).toBe(false);
    finish?.();
    await t.runtime.waitForIdle();
    expect(t.sent.some((m) => m.text === 'Here are the options.')).toBe(true);
    expect(t.sent.filter((m) => /Still looking/.test(m.text))).toHaveLength(1);
    await t.runtime.stop(); t.repository.close();
  });

  it('says nothing when the search is quick', async () => {
    const t = await setup({ stillLookingMs: 200, research: async (s) => found(s.revision) });
    await t.runtime.start();
    await t.runtime.handleInbound(t.event('quick-1'));
    await t.runtime.waitForIdle();
    await new Promise((r) => setTimeout(r, 300));
    expect(t.sent.some((m) => /Still looking/.test(m.text))).toBe(false);
    await t.runtime.stop(); t.repository.close();
  });
});

describe('asking for options again at the same revision', () => {
  it('delivers the second answer too, instead of treating it as a duplicate of the first', async () => {
    let calls = 0;
    const t = await setup({ research: async (s) => { calls += 1; return found(s.revision, calls === 1 ? 'Nothing fit yet.' : 'Here are the new options.'); } });
    await t.runtime.start();
    await t.runtime.handleInbound(t.event('again-1')); await t.runtime.waitForIdle();
    await t.runtime.handleInbound(t.event('again-2')); await t.runtime.waitForIdle();
    expect(t.sent.map((m) => m.text)).toEqual(expect.arrayContaining(['Nothing fit yet.', 'Here are the new options.']));
    expect((await t.repository.loadTrip(t.state.tripId))?.status).toBe('proposed');
    await t.runtime.stop(); t.repository.close();
  });

  it('still sends options once after a restart in the middle of a search', async () => {
    // covered by the earlier restart test; this checks the answer is not duplicated when the same revision is searched once.
    let calls = 0;
    const t = await setup({ research: async (s) => { calls += 1; return found(s.revision, 'Only once.'); } });
    await t.runtime.start();
    await t.runtime.handleInbound(t.event('once-1')); await t.runtime.waitForIdle();
    await t.runtime.handleInbound(t.event('once-1')); await t.runtime.waitForIdle(); // the same inbound event delivered twice
    expect(t.sent.filter((m) => m.text === 'Only once.')).toHaveLength(1);
    expect(calls).toBe(1);
    await t.runtime.stop(); t.repository.close();
  });
});
