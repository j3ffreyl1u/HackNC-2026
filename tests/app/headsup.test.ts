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
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real conversation, runtime and planner over a mock phone line with two enrolled people. */
async function live() {
  const dir = mkdtempSync(join(tmpdir(), 'headsup-')); dirs.push(dir);
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
  /** Send one DM and return exactly what each phone received because of it. */
  const say = async (from: string, text: string) => {
    const before = messenger.sent.length;
    await messenger.emit(dmEvent(from, `m${++n}`, text));
    await runtime.drainOutbox(); await runtime.waitForIdle(); await runtime.drainOutbox();
    const out = messenger.sent.slice(before).filter((s) => s.audience.kind === 'private');
    const to = (who: string) => out.filter((s) => s.audience.kind === 'private' && s.audience.providerUserId === who).map((s) => s.text);
    return { jeff: to(JEFF), mason: to(MASON) };
  };
  return { say, stop: async () => { await runtime.stop(); repository.close(); } };
}

const START = "I'm leaving from Chapel Hill, 2 nights, I have a car";

describe('heads-up when someone changes a shared detail', () => {
  it('tells the other person, once, and not the person who changed it', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(JEFF, "let's go to Boone");
    const changed = await t.say(JEFF, "actually I'm leaving from Raleigh");
    expect(changed.mason.filter((x) => /changed the starting point to Raleigh/i.test(x))).toHaveLength(1);
    expect(changed.mason.join(' ')).toMatch(/Jeffrey/);
    expect(changed.jeff.join(' ')).not.toMatch(/changed the starting point/i);
    await t.stop();
  });

  it('says nothing when a detail is only repeated, not changed', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(JEFF, "let's go to Boone");
    await t.say(JEFF, "actually I'm leaving from Raleigh");
    const again = await t.say(JEFF, "I'm leaving from Raleigh");
    expect(again.mason.join(' ')).not.toMatch(/changed the starting point/i);
    await t.stop();
  });

  it('says so when the car is no longer available, and when the trip length changes', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(JEFF, "let's go to Boone");
    const length = await t.say(JEFF, 'make it 3 nights');
    expect(length.mason.join(' ')).toMatch(/changed the trip to 3 nights/i);
    await t.stop();
  });

  it('never puts a budget in a heads-up, and two changes in one message are both announced', async () => {
    const t = await live();
    await t.say(JEFF, `${START}, my max is $137`);
    await t.say(JEFF, "let's go to Boone");
    const out = await t.say(JEFF, "actually I'm leaving from Raleigh, make it 3 nights");
    expect(out.mason.filter((x) => /changed/i.test(x))).toHaveLength(2);
    expect(out.mason.join(' ')).toMatch(/starting point to Raleigh/i);
    expect(out.mason.join(' ')).toMatch(/3 nights/i);
    expect(out.mason.join(' ')).not.toMatch(/137|\$|budget|max\b/i);
    await t.stop();
  });
});

describe('telling both people about a disagreement, and when it is settled', () => {
  it('tells both phones about different starting points, then tells both when it is settled', async () => {
    const t = await live();
    await t.say(JEFF, START);
    const clash = await t.say(MASON, "I'm leaving from Durham");
    for (const heard of [clash.jeff, clash.mason]) expect(heard.join(' ')).toMatch(/different departure cities|Chapel Hill|Durham/i);
    const settled = await t.say(MASON, "I'm leaving from Chapel Hill");
    expect(settled.jeff.join(' ') + settled.mason.join(' ')).toMatch(/Great, we'll plan the trip from Chapel Hill/i);
    await t.stop();
  });
});

describe('nudging the person the asker is waiting on', () => {
  it('nudges the other person once about what they owe, without any amounts', async () => {
    const t = await live();
    await t.say(JEFF, `${START}, I'm free Nov 14-16, my max is $137, I like hiking`);
    await t.say(JEFF, "let's go to Boone");
    const first = await t.say(JEFF, 'show us some options');
    expect(first.mason.some((x) => /Jeffrey is ready to see trip options and is just waiting on your/i.test(x))).toBe(true);
    expect(first.mason.join(' ')).not.toMatch(/137|\$/);
    const second = await t.say(JEFF, 'show us some options');
    expect(second.mason.filter((x) => /is ready to see trip options/i.test(x))).toHaveLength(0);
    await t.stop();
  });

  it('does not chase anyone before the asker has given any details', async () => {
    const t = await live();
    const out = await t.say(JEFF, 'show us some options');
    expect(out.mason.join(' ')).not.toMatch(/is ready to see trip options/i);
    await t.stop();
  });
});
