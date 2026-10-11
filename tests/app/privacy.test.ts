import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatAdapter } from '../../src/app/conversation-adapter.js';
import { loadEnrolledTrip } from '../../src/app/fixture.js';
import { createPlannerAdapter } from '../../src/app/planning-adapter.js';
import { createApplicationRuntime } from '../../src/app/runtime.js';
import { MockMessenger } from '../../src/conversation/index.js';
import { dmEvent } from '../../src/conversation/mock.js';
import { defaultFixtures } from '../../src/research/fixtures.js';
import { createResearchProvider } from '../../src/research/provider.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';

const JEFF = '+15550000001';
const MASON = '+15550000002';
// Distinctive caps, so any appearance of one on the other phone is unmistakable.
const JEFF_CAP = 137;
const MASON_CAP = 291;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real conversation, runtime and planner over a mock phone line with two enrolled people in direct mode. */
async function live() {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-')); dirs.push(dir);
  const path = join(dir, 'trip.json');
  writeFileSync(path, JSON.stringify({ mode: 'direct', tripId: 'dm', groupSpaceId: 'direct:dm', participants: [
    { memberId: 'jeffrey', displayName: 'Jeffrey', providerUserId: JEFF, consentedAt: '2026-10-10T12:00:00Z' },
    { memberId: 'mason', displayName: 'Mason', providerUserId: MASON, consentedAt: '2026-10-10T12:00:00Z' },
  ] }));
  const trip = await loadEnrolledTrip(path);
  const repository = SqliteTripRepository.open(join(dir, 'trips.sqlite'));
  await repository.bootstrapTrip(trip.enrollment, trip.state);
  const messenger = new MockMessenger();
  const chat = await createChatAdapter(trip.enrollment, trip.state.timeZone ?? 'America/New_York', 'mock', process.env, messenger);
  const planner = createPlannerAdapter(createResearchProvider({ mode: 'mock', fixtures: defaultFixtures }), trip.enrollment.groupSpaceId);
  const runtime = createApplicationRuntime({ repository, conversation: chat.conversation, planner, tripId: 'dm' });
  await runtime.start();
  let n = 0;
  const heard: Record<string, string[]> = { [JEFF]: [], [MASON]: [] };
  const say = async (from: string, text: string) => {
    const before = messenger.sent.length;
    await messenger.emit(dmEvent(from, `m${++n}`, text));
    await runtime.drainOutbox();
    await runtime.waitForIdle();
    await runtime.drainOutbox();
    for (const s of messenger.sent.slice(before)) if (s.audience.kind === 'private') heard[s.audience.providerUserId]?.push(s.text);
  };
  return { say, heard, stop: async () => { await runtime.stop(); repository.close(); } };
}

const personal = /your max|over your|your limit|your budget|you gave|you said/i;
/** Texts delivered to both phones, i.e. shared messages. None of them may talk about one person's own limit. */
const sharedPersonal = (heard: Record<string, string[]>) => heard[JEFF]!.filter((x) => heard[MASON]!.includes(x)).filter((x) => personal.test(x));
const mentions = (texts: string[], cap: number) => texts.filter((t) => new RegExp(`\\$\\s?${cap}\\b|\\b${cap}00\\b|\\b${cap}\\b`).test(t));

describe('private budgets never reach the other person\'s phone', () => {
  it('through starting, answering, asking for options, a cap that is too low, and a cap change', async () => {
    const t = await live();
    await t.say(JEFF, "Hi, let's plan a trip");
    await t.say(JEFF, `I'm leaving from Chapel Hill, 2 nights, I have a car, I'm free Nov 14-16, my max is $${JEFF_CAP}, I like hiking`);
    await t.say(MASON, `my max is $${MASON_CAP}, free Nov 14-16, I like food`);
    await t.say(JEFF, "let's go to Boone");
    await t.say(JEFF, 'show us some options');
    await t.say(JEFF, 'show us some options');
    await t.say(MASON, 'show us some options');
    await t.say(JEFF, 'my max is $500');
    await t.say(MASON, 'show us some options');
    await t.say(MASON, 'my max is $120');
    await t.say(JEFF, 'show us some options');
    // The scenario must actually reach the risky moments, or a pass would prove nothing.
    expect(t.heard[JEFF]!.some((x) => /over your max/.test(x)), 'Jeffrey was told privately how far over his max').toBe(true);
    expect(t.heard[MASON]!.some((x) => /over your max/.test(x)), 'Mason was told privately how far over his max').toBe(true);
    expect(t.heard[JEFF]!.some((x) => /Good news, I found/.test(x)) && t.heard[MASON]!.some((x) => /Good news, I found/.test(x)), 'both were shown plans').toBe(true);
    expect(sharedPersonal(t.heard), 'a shared message talked about one person\'s own limit').toEqual([]);
    expect(mentions(t.heard[MASON]!, JEFF_CAP), 'Jeffrey\'s first cap on Mason\'s phone').toEqual([]);
    expect(mentions(t.heard[MASON]!, 500), 'Jeffrey\'s second cap on Mason\'s phone').toEqual([]);
    expect(mentions(t.heard[JEFF]!, MASON_CAP), 'Mason\'s first cap on Jeffrey\'s phone').toEqual([]);
    expect(mentions(t.heard[JEFF]!, 120), 'Mason\'s second cap on Jeffrey\'s phone').toEqual([]);
    await t.stop();
  });

  it('never sends a message that talks about someone\'s own limit to both phones', async () => {
    const t = await live();
    await t.say(JEFF, `I'm leaving from Chapel Hill, 2 nights, I have a car, I'm free Nov 14-16, my max is $${JEFF_CAP}`);
    await t.say(MASON, `my max is $${MASON_CAP}, free Nov 14-16`);
    await t.say(JEFF, "let's go to Boone");
    await t.say(JEFF, 'show us some options');
    await t.say(MASON, 'show us some options');
    expect(sharedPersonal(t.heard)).toEqual([]);
    await t.stop();
  });
});

describe('naming whose limit is in the way, without saying how much', () => {
  async function conflict() {
    const t = await live();
    await t.say(JEFF, `I'm leaving from Chapel Hill, 2 nights, I have a car, I'm free Nov 14-16, my max is $${JEFF_CAP}, I like hiking`);
    await t.say(MASON, `my max is $${MASON_CAP}, free Nov 14-16, I like food`);
    await t.say(JEFF, "let's go to Boone");
    await t.say(JEFF, 'show us some options');
    await t.say(MASON, 'show us some options');
    return t;
  }

  it('the shared message names the person who would have to flex, and no amount reaches the other phone', async () => {
    const t = await conflict();
    const shared = t.heard[MASON]!.filter((x) => t.heard[JEFF]!.includes(x));
    expect(shared.some((x) => /Jeffrey, I'm sending you a private note/.test(x)), 'the lower limit is named in the shared message').toBe(true);
    expect(shared.some((x) => /Mason/.test(x) && /private note/.test(x)), 'the higher limit is not blamed').toBe(false);
    expect(shared.filter((x) => /\$\s?\d/.test(x) && /max|limit|budget|afford|spend/i.test(x)), 'a shared message with a dollar amount about a limit').toEqual([]);
    expect(t.heard[JEFF]!.some((x) => /over your max/.test(x)), 'Jeffrey got the exact amount privately').toBe(true);
    expect(t.heard[MASON]!.some((x) => /over your max/.test(x)), 'Mason did not').toBe(false);
    expect(mentions(t.heard[MASON]!, JEFF_CAP)).toEqual([]);
    await t.stop();
  });

  it('a change to one limit sends each phone one note about it, not two', async () => {
    const t = await live();
    await t.say(JEFF, `I'm leaving from Chapel Hill, 2 nights, I have a car, I'm free Nov 14-16, my max is $900, I like hiking`);
    await t.say(MASON, 'my max is $950, free Nov 14-16, I like food');
    await t.say(JEFF, "let's go to Boone");
    await t.say(JEFF, 'show us some options');
    await t.say(MASON, 'show us some options');
    const before: Record<string, number> = { [JEFF]: t.heard[JEFF]!.length, [MASON]: t.heard[MASON]!.length };
    await t.say(JEFF, 'my max is $1000');
    for (const phone of [JEFF, MASON]) {
      const notes = t.heard[phone]!.slice(before[phone]!).filter((x) => /budget limit/i.test(x));
      expect(notes, `notes on ${phone}`).toHaveLength(1);
    }
    await t.stop();
  });
});

