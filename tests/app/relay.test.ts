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
  const dir = mkdtempSync(join(tmpdir(), 'relay-')); dirs.push(dir);
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

const START = "I'm leaving from Chapel Hill, 2 nights, NC mountains, my max is $137, I like hiking";

describe('asking and telling through the bot', () => {
  it('"ask Mason if he has a car" puts the question to Mason and tells the asker, then passes the answer back', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17");
    const asked = await t.say(JEFF, 'Can you ask Mason if he has a car');
    expect(asked.mason.join(' ')).toMatch(/Jeffrey was wondering: Does anyone have a car/);
    expect(asked.jeff.join(' ')).toMatch(/Done, I asked Mason/);
    const answer = await t.say(MASON, 'yes');
    expect(answer.jeff.join(' ')).toMatch(/Mason has a car\./);
    await t.stop();
  });

  it('"ask Mason if he has one" right after the car question means a car', async () => {
    const t = await live();
    await t.say(JEFF, START);                          // the bot now asks Jeffrey about a car
    await t.say(MASON, "I'm free Nov 14-17");
    const asked = await t.say(JEFF, 'Can you ask Mason if he has one');
    expect(asked.mason.join(' ')).toMatch(/Jeffrey was wondering: Does anyone have a car/);
    const back = await t.say(MASON, 'yes');
    expect(back.jeff.join(' ')).toMatch(/Mason has a car\./);
    await t.stop();
  });

  it('a "no" is passed back too', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17");
    await t.say(JEFF, 'ask Mason if he has a car');
    const answer = await t.say(MASON, "nope I don't have one");
    expect(answer.jeff.join(' ')).toMatch(/Mason doesn't have a car/);
    await t.stop();
  });

  it('"tell Mason I have a car" sends Mason the words and records the car for Jeffrey', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17");
    const told = await t.say(JEFF, 'tell Mason I have a car');
    expect(told.mason.join(' ')).toMatch(/Jeffrey wanted you to know: "I have a car"/);
    expect(told.jeff.join(' ')).toMatch(/Done, I let Mason know/);
    await t.stop();
  });

  it('asking for dates or likes uses the standard question and passes the answer back', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, 'hey');
    const dates = await t.say(JEFF, 'ask Mason for his dates');
    expect(dates.mason.join(' ')).toMatch(/Jeffrey was wondering: Which dates could you do/);
    const back = await t.say(MASON, 'Nov 15-17 works for me');
    expect(back.jeff.join(' ')).toMatch(/Mason is free Nov 15-17/);
    await t.stop();
  });

  it('a free-form question is put to them in second person and the answer is passed back as said', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17");
    const asked = await t.say(JEFF, 'ask Mason if he can pick me up at 8');
    expect(asked.mason.join(' ')).toMatch(/Jeffrey would like to know: if you can pick Jeffrey up at 8\?/);
    const back = await t.say(MASON, 'sure');
    expect(back.jeff.join(' ')).toMatch(/Mason says: "sure"/);
    await t.stop();
  });

  it('works the other way round', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17");
    const told = await t.say(MASON, 'tell Jeffrey I like museums and food');
    expect(told.jeff.join(' ')).toMatch(/Mason wanted you to know: "I like museums and food"/);
    await t.say(MASON, 'ask Jeffrey if he has a car');
    const back = await t.say(JEFF, 'yeah I do');
    expect(back.mason.join(' ')).toMatch(/Jeffrey has a car\./);
    await t.stop();
  });

  it('never asks for or carries a budget, and "tell Mason to hurry up" is still just a nudge', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17, my max is $99");
    const hurry = await t.say(JEFF, 'tell Mason to hurry up');
    expect(hurry.mason.join(' ')).not.toMatch(/to know|wanted you to know/);
    const asked = await t.say(JEFF, 'ask Mason what his budget is');
    expect(asked.mason).toEqual([]);
    expect(asked.jeff.join(' ')).toMatch(/Budgets stay private/);
    const told = await t.say(JEFF, 'tell Mason my max is $137');
    expect(told.mason).toEqual([]);
    expect(told.jeff.join(' ')).toMatch(/Budgets stay private/);
    await t.stop();
  });

  it('an answer that mentions money is not passed back', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17");
    await t.say(JEFF, 'ask Mason if he can cover the hotel');
    const back = await t.say(MASON, 'sure, I can put in 300 dollars');
    expect(back.jeff.join(' ')).toMatch(/answered, but I keep anything about money private/);
    expect(back.jeff.join(' ')).not.toMatch(/300/);
    await t.stop();
  });

  it('an unknown name or a missing message gets a helpful answer', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17");
    expect((await t.say(JEFF, 'ask Bob if he has a car')).jeff.join(' ')).toMatch(/not sure who Bob is.*Mason/);
    expect((await t.say(JEFF, 'tell Mason')).jeff.join(' ')).toMatch(/What would you like me to tell Mason\?/);
    await t.stop();
  });

  // Mason has not texted the bot at all in these: the person asking is the one who wants him contacted.
  it('"Message Mason to start planning it" (from a real phone) texts Mason an invitation', async () => {
    const t = await live();
    await t.say(JEFF, 'I want to plan a trip');
    const r = await t.say(JEFF, 'Message Mason to start planning it');
    expect(r.mason.join(' ')).toMatch(/Hey Mason! Jeffrey wants to plan a trip with you and asked me to get you started/);
    expect(r.jeff.join(' ')).toMatch(/Done, I messaged Mason/);
    await t.stop();
  });

  it.each([
    'text Mason to join', 'have Mason start planning', 'get Mason to join the planning', 'invite Mason', 'bring Mason in', 'Could you tell Mason to start planning?',
    'ask Mason to join us', 'please message Mason to get started', 'add Mason', 'message Mason and tell him to start planning', 'text Mason and ask him to join',
  ])('"%s" invites Mason', async (text) => {
    const t = await live();
    await t.say(JEFF, 'I want to plan a trip');
    const r = await t.say(JEFF, text);
    expect(r.mason.join(' ')).toMatch(/wants to plan a trip with you and asked me to get you started/);
    await t.stop();
  });

  it.each([
    ['Message Mason that I have a car', /Jeffrey wanted you to know: "I have a car"/],
    ["text Mason I'll be a few minutes late", /Jeffrey wanted you to know: "I'll be a few minutes late"/],
    ['send Mason a message saying we leave at 8', /Jeffrey wanted you to know: "we leave at 8"/],
    ['message Mason: bring snacks', /Jeffrey wanted you to know: "bring snacks"/],
    ['DM Mason hi there', /Jeffrey wanted you to know: "hi there"/],
  ])('"%s" sends Mason the message', async (text, expected) => {
    const t = await live();
    await t.say(JEFF, 'I want to plan a trip');
    const r = await t.say(JEFF, text as string);
    expect(r.mason.join(' ')).toMatch(expected as RegExp);
    expect(r.jeff.join(' ')).toMatch(/Done, I let Mason know/);
    await t.stop();
  });

  it.each([
    ['message Mason to bring snacks', /Jeffrey would like you to bring snacks\./],
    ['remind Mason to pack a charger', /Jeffrey would like you to pack a charger\./],
    ['tell Mason to look at the options', /Jeffrey would like you to look at the options\./],
  ])('"%s" passes on a request', async (text, expected) => {
    const t = await live();
    await t.say(JEFF, 'I want to plan a trip');
    const r = await t.say(JEFF, text as string);
    expect(r.mason.join(' ')).toMatch(expected as RegExp);
    await t.stop();
  });

  it('"message Mason and ask if he has a car" is a question that gets answered back', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17");
    const r = await t.say(JEFF, 'message Mason and ask if he has a car');
    expect(r.mason.join(' ')).toMatch(/Jeffrey was wondering: Does anyone have a car/);
    expect((await t.say(MASON, 'yes')).jeff.join(' ')).toMatch(/Mason has a car\./);
    await t.stop();
  });

  it('messaging someone who is not in the trip, or with nothing to say, is answered', async () => {
    const t = await live();
    await t.say(JEFF, START);
    expect((await t.say(JEFF, 'message Bob hi')).jeff.join(' ')).toMatch(/not sure who Bob is.*Mason/);
    expect((await t.say(JEFF, 'message Mason')).jeff.join(' ')).toMatch(/What would you like me to tell Mason\?/);
    await t.stop();
  });

  it('ordinary sentences that start with these words are not relayed', async () => {
    const t = await live();
    await t.say(JEFF, START);
    for (const text of ['have fun', 'add a hike', 'text me the plan', 'remind me later']) {
      expect((await t.say(JEFF, text)).mason, text).toEqual([]);
    }
    await t.stop();
  });
});
