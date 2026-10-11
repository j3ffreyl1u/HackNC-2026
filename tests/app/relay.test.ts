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
async function live(extra: Partial<Parameters<typeof createApplicationRuntime>[0]> = {}) {
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
  const runtime = createApplicationRuntime({ repository, conversation: chat.conversation, planner, tripId: 'dm', ...extra });
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
  it('"text Mason and see if he is cool with it" is a question, and a request back is not passed on as the answer', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17");
    const asked = await t.say(JEFF, 'text mason and see if hes cool with the first one');
    expect(asked.mason.join(' ')).toMatch(/Jeffrey was wondering if you're cool with the first one\?/);
    const back = await t.say(MASON, 'ask jeffrey what he wants to eat');
    expect(back.jeff.join(' ')).toMatch(/Mason would like to know what you want to eat\./);
    expect(back.jeff.join(' ')).not.toMatch(/Mason says/);
    expect((await t.say(JEFF, 'ask mason if he wants to leave early')).mason.join(' ')).toMatch(/was wondering if you want to leave early/);
    await t.stop();
  });

  it('one car is enough, and a budget in a message that also names the other person is still the sender\'s own', async () => {
    const t = await live();
    const first = await t.say(JEFF, "lets do a trip w mason. im in raleigh, budget around $350, free dec 5-7, i got a car");
    expect(first.jeff.join(' ')).not.toMatch(/can only take a budget from the person/);
    expect(first.jeff.join(' ')).toMatch(/your max is \$350/);
    const second = await t.say(MASON, 'im comin from charlotte, no car tho');
    expect([...second.jeff, ...second.mason].join(' ')).not.toMatch(/conflicting answers about whether you have a car/);
    await t.stop();
  });

  it('a maybe on the dates followed by yes saves the dates, and money talk gets the read-only answer', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17");
    await t.say(JEFF, 'maybe Dec 5-7?');
    expect((await t.say(JEFF, 'yes')).jeff.join(' ')).toMatch(/you're free Dec 5-7/);
    for (const text of ['pay my share', 'venmo mason']) {
      expect((await t.say(JEFF, text)).jeff.join(' '), text).toMatch(/I can't pay or log spending from here/);
    }
    for (const text of ['i covered everyones dinner', 'i spent 60 on gas']) {
      expect((await t.say(JEFF, text)).jeff.join(' '), text).toMatch(/once everyone has approved a plan/);
    }
    expect((await t.say(JEFF, 'can we do a day earlier')).jeff.join(' ')).toMatch(/exact dates/);
    await t.stop();
  });

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
    expect(asked.mason.join(' ')).toMatch(/Jeffrey was wondering if you can pick Jeffrey up at 8\?/);
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

  // The conversation from the real phone, once a plan is picked and one person has said "I'm in".
  async function waitingOnMason() {
    const t = await live();
    await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, NC mountains, I have a car, I'm free Nov 14-17, my max is $340, I like hiking");
    for (const m of ['hey', 'sounds good', "I'm free Nov 14-17, my max is $310, I like food"]) await t.say(MASON, m);
    await t.say(JEFF, 'option 1');
    await t.say(JEFF, "I'm in");
    return t;
  }

  it('"did he answer?" is about the question that was passed on, not about "I\'m in"', async () => {
    const t = await waitingOnMason();
    await t.say(JEFF, 'ask mason if he can drive');
    expect((await t.say(JEFF, 'did he answer')).jeff.join(' ')).toMatch(/Not yet\. I asked Mason/);
    await t.say(MASON, 'yeah i can drive');
    expect((await t.say(JEFF, 'did he answer')).jeff.join(' ')).toMatch(/Yes, Mason said: "yeah i can drive"/);
    await t.stop();
  });

  it('a second "I\'m in" says they are already in, and thanks that name a person are just thanks', async () => {
    const t = await waitingOnMason();
    expect((await t.say(JEFF, "I'm in")).jeff.join(' ')).toMatch(/already in on .+ Still waiting on Mason/);
    expect((await t.say(JEFF, 'thanks mason is the best')).jeff.join(' ')).not.toMatch(/didn't quite catch/);
    await t.stop();
  });

  it('"remind Mason to lock it in" asks Mason for the I\'m in, naming the plan', async () => {
    const t = await waitingOnMason();
    const r = await t.say(JEFF, 'Can you remind mason to lock it in');
    expect(r.mason.join(' ')).toMatch(/Hey Mason! Jeffrey is in on .+ and is waiting on you\. Say "I'm in" to lock it in\./);
    expect(r.jeff.join(' ')).toMatch(/Done, I let Mason know/);
    expect((await t.say(JEFF, 'remind Mason')).mason.join(' ')).toMatch(/waiting on you\. Say "I'm in"/);
    await t.stop();
  });

  it.each(['Has he done it', 'Has he said ok', 'Has Mason confirmed?', 'Did Mason approve it', "Can you ask if he's done it", 'Yes ask if Mason has done it', 'Ask if Mason has confirmed the option for the trip', 'is Mason in', 'check whether he has locked it in'])('"%s" is answered exactly, without bothering Mason', async (text) => {
    const t = await waitingOnMason();
    const r = await t.say(JEFF, text);
    expect(r.jeff.join(' ')).toMatch(/Not yet, Mason hasn't said "I'm in" on .+\. Want me to remind them\?/);
    expect(r.mason).toEqual([]);
    await t.stop();
  });

  it('"Did I confirm" and "who\'s left" are exact too, and the answer changes once Mason says I\'m in', async () => {
    const t = await waitingOnMason();
    expect((await t.say(JEFF, 'Did I confirm')).jeff.join(' ')).toMatch(/Yes, you're in on .+\. Still waiting on Mason\./);
    expect((await t.say(JEFF, "who's left?")).jeff.join(' ')).toMatch(/still waiting on Mason/);
    expect((await t.say(JEFF, 'are we done?')).jeff.join(' ')).toMatch(/Not yet/);
    await t.say(MASON, "I'm in");
    expect((await t.say(JEFF, 'Has he said ok')).jeff.join(' ')).toMatch(/Yes, Mason is in, and so is everyone else/);
    expect((await t.say(JEFF, 'are we done?')).jeff.join(' ')).toMatch(/Yes, everyone is in/);
    await t.stop();
  });

  it('someone who has not said I\'m in is told so, and what is waiting on them', async () => {
    const t = await waitingOnMason();
    expect((await t.say(MASON, 'did I confirm?')).mason.join(' ')).toMatch(/Not yet\. Say "I'm in" to lock in/);
    expect((await t.say(MASON, 'has Jeffrey said ok?')).mason.join(' ')).toMatch(/Yes, Jeffrey is in\. Still waiting on you\./);
    await t.stop();
  });

  it('"Yes pass to Mason and ask" says what is missing instead of nodding along', async () => {
    const t = await waitingOnMason();
    expect((await t.say(JEFF, 'Yes pass to Mason and ask')).jeff.join(' ')).toMatch(/What would you like me to ask Mason\?/);
    await t.stop();
  });

  it('"ask if he has a car" works without a name when there is one other person, and with leading yes/ok', async () => {
    const t = await live();
    await t.say(JEFF, START);
    await t.say(MASON, "I'm free Nov 14-17");
    expect((await t.say(JEFF, 'Can you ask if he has a car')).mason.join(' ')).toMatch(/Jeffrey was wondering: Does anyone have a car/);
    expect((await t.say(JEFF, 'ok tell him I will bring snacks')).mason.join(' ')).toMatch(/Jeffrey wanted you to know: "I will bring snacks"/);
    await t.stop();
  });

  it('"Did you tell Mason that I have a car?" is answered from what was sent, not taken as a new fact', async () => {
    const t = await live();
    await t.say(JEFF, 'I want to plan a trip');
    const before = await t.say(JEFF, 'Did you tell Mason that I have a car?');
    expect(before.jeff.join(' ')).toMatch(/No, I haven't sent Mason anything about that yet\./);
    expect(before.jeff.join(' ')).not.toMatch(/we have a car|Got it/);
    await t.say(JEFF, 'tell Mason I have a car');
    expect((await t.say(JEFF, 'Did you tell Mason that I have a car?')).jeff.join(' ')).toMatch(/Yes, I told Mason: "I have a car"\./);
    expect((await t.say(JEFF, 'did you ask him anything?')).jeff.join(' ')).toMatch(/No, I haven't sent Mason anything yet|Yes, I/);
    await t.say(JEFF, 'ask Mason if he has a car');
    expect((await t.say(JEFF, 'What did you tell Mason?')).jeff.join(' ')).toMatch(/So far I told Mason: "I have a car"; and asked Mason: "if he has a car"\./);
    expect((await t.say(JEFF, 'Did Mason get my message?')).jeff.join(' ')).toMatch(/So far I .*I can't see whether they've read it/);
    await t.stop();
  });

  it('nudging Mason once a plan is picked asks for the I\'m in, and never starts a new search or drops the pick', async () => {
    const t = await waitingOnMason();
    for (const text of ['tell mason hurry up and say im in', 'tell Mason to hurry up', 'nudge Mason', 'ping mason']) {
      const r = await t.say(JEFF, text);
      expect(r.mason.join(' '), text).toMatch(/waiting on you\. Say "I'm in" to lock it in\./);
      expect(r.mason.join(' ') + r.jeff.join(' '), text).not.toMatch(/Good news|found two trips|Option 1/);
    }
    // the pick is still there: Mason can say I'm in and the plan is approved
    expect((await t.say(MASON, "I'm in")).jeff.join(' ')).toMatch(/approved/i);
    expect((await t.say(JEFF, 'tell Mason to hurry up')).jeff.join(' ')).toMatch(/already in on/);
    await t.stop();
  });
});

describe('logging a purchase from chat', () => {
  async function approvedWithLogger() {
    const logged: Array<[string, string, number, string]> = [];
    const t = await live({ purchaseLogger: { log: async (m, c, d, w) => { logged.push([m, c, d, w]); return `p${logged.length}`; } } });
    await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, NC mountains, I have a car, I'm free Nov 14-17, my max is $340, I like hiking");
    for (const m of ['hey', 'sounds good', "I'm free Nov 14-17, my max is $310, I like food"]) await t.say(MASON, m);
    await t.say(JEFF, 'option 1'); await t.say(JEFF, "I'm in"); await t.say(MASON, "I'm in");
    return { t, logged };
  }
  it('"I just paid gas" asks how much, then asks for a yes, then logs it and tells the other person', async () => {
    const { t, logged } = await approvedWithLogger();
    expect((await t.say(JEFF, 'I just paid gas')).jeff.join(' ')).toMatch(/How much was gas\?/);
    expect((await t.say(JEFF, '$60')).jeff.join(' ')).toMatch(/Log \$60 for gas to your simulated Nessie account\? Say "yes"/);
    expect(logged).toHaveLength(0);
    const done = await t.say(JEFF, 'yes');
    expect(done.jeff.join(' ')).toMatch(/Logged: you paid \$60 for gas/);
    expect(done.mason.join(' ')).toMatch(/Jeffrey logged \$60 for gas \(simulated\)/);
    expect(logged).toEqual([['jeffrey', 'fuel_parking_tolls', 60, 'gas']]);
    await t.stop();
  });
  it('an amount in the message skips the question, and a no or any other message drops it', async () => {
    const { t, logged } = await approvedWithLogger();
    expect((await t.say(MASON, 'I paid $110 for the hotel')).mason.join(' ')).toMatch(/Log \$110 for hotel to your simulated Nessie account\?/);
    expect((await t.say(MASON, 'no')).mason.join(' ')).toMatch(/didn't log anything/);
    await t.say(MASON, 'I covered everyones dinner');
    await t.say(MASON, 'what was the plan again');   // not an amount or a yes: dropped
    await t.say(MASON, 'yes');
    expect(logged).toHaveLength(0);
    await t.stop();
  });
  it('food asks whether it was for everyone, and "everyone" splits it while "just me" keeps it personal', async () => {
    const { t, logged } = await approvedWithLogger();
    expect((await t.say(JEFF, 'I paid $150 for food')).jeff.join(' ')).toMatch(/Was the \$150 for food for everyone, or just you\?/);
    const shared = await t.say(JEFF, 'everyone');
    expect(shared.jeff.join(' ')).toMatch(/Logged: you paid \$150 for food, split with everyone/);
    expect(shared.mason.join(' ')).toMatch(/Jeffrey logged \$150 for food, split with everyone/);
    expect((await t.say(MASON, 'I covered everyones dinner')).mason.join(' ')).toMatch(/How much was dinner\?/);
    expect((await t.say(MASON, '40')).mason.join(' ')).toMatch(/Log \$40 for dinner and split it with everyone/);
    await t.say(MASON, 'yes');
    expect((await t.say(MASON, 'I paid $20 for lunch')).mason.join(' ')).toMatch(/for everyone, or just you\?/);
    expect((await t.say(MASON, 'just me')).mason.join(' ')).toMatch(/kept personal/);
    expect(logged.map((l) => l[2])).toEqual([150, 40, 20]);
    await t.stop();
  });
  it('flights are a travel cost, like gas', async () => {
    const { t, logged } = await approvedWithLogger();
    expect((await t.say(JEFF, 'I paid $400 for flights')).jeff.join(' ')).toMatch(/Log \$400 for flights/);
    await t.say(JEFF, 'yes');
    expect(logged).toEqual([['jeffrey', 'fuel_parking_tolls', 400, 'flights']]);
    await t.stop();
  });
  it('before a plan is approved it says to wait', async () => {
    const { t } = await approvedWithLogger();
    const fresh = await live({ purchaseLogger: { log: async () => 'p1' } });
    expect((await fresh.say(JEFF, 'I paid $60 for gas')).jeff.join(' ')).toMatch(/once everyone has approved a plan/);
    await fresh.stop(); await t.stop();
  });
});

describe('car or plane', () => {
  it('asks driving or flying; flying needs no car; driving asks whose car', async () => {
    const t = await live();
    const first = await t.say(JEFF, "leaving from Chapel Hill, 2 nights, the mountains, free Nov 14-17, I like hiking");
    expect(first.jeff.join(' ')).toMatch(/Are you planning on driving or flying\?/);
    expect((await t.say(JEFF, 'flying')).jeff.join(' ')).toMatch(/you're flying/);
    const mason = await t.say(MASON, "im in, free Nov 14-17, I like food");
    expect([...mason.jeff, ...mason.mason].join(' ')).not.toMatch(/conflicting answers|isn't a car|no car/);
    await t.stop();
    const u = await live();
    await u.say(JEFF, "leaving from Chapel Hill, 2 nights, the mountains, free Nov 14-17, I like hiking");
    const driving = await u.say(JEFF, 'driving');
    expect(driving.jeff.join(' ')).toMatch(/you're driving/);
    expect(driving.jeff.join(' ')).toMatch(/Whose car are we taking\?/);
    expect((await u.say(JEFF, 'mine')).jeff.join(' ')).toMatch(/there's a car/);
    await u.stop();
  });
  it('one person flying and another driving is a conflict that is asked once and settled', async () => {
    const t = await live();
    await t.say(JEFF, "leaving from Chapel Hill, 2 nights, the mountains, free Nov 14-17, I like hiking, I have a car");
    const clash = await t.say(MASON, "I'll fly, free Nov 14-17, I like food");
    expect([...clash.jeff, ...clash.mason].join(' ')).toMatch(/driving and some said flying/);
    const settled = await t.say(MASON, 'ok driving then');
    expect([...settled.jeff, ...settled.mason].join(' ')).toMatch(/we're driving|Great/);
    await t.stop();
  });
});

describe('the order of the basics questions', () => {
  it('asks driving or flying right after the starting city, and the place question for a flight does not talk about driving', async () => {
    const t = await live();
    const afterCity = await t.say(JEFF, "I'm planning a trip, leaving from Chapel Hill");
    expect(afterCity.jeff.join(' ')).toMatch(/driving or flying\?/);
    expect(afterCity.jeff.join(' ')).not.toMatch(/how many nights/i);
    const afterFly = await t.say(JEFF, "I'm thinking of flying");
    expect(afterFly.jeff.join(' ')).toMatch(/you're flying/);
    expect(afterFly.jeff.join(' ')).toMatch(/How many nights/);
    const afterNights = await t.say(JEFF, '2 nights');
    expect(afterNights.jeff.join(' ')).toMatch(/Where would you like to fly to\?/);
    expect(afterNights.jeff.join(' ')).not.toMatch(/driving/i);
    await t.stop();
  });
});

describe('final-merge fixes', () => {
  it('"I\'m in" plus their own facts keeps both, and "mine" or "the first one" is never saved as a city', async () => {
    const t = await live();
    await t.say(JEFF, "leaving from Chapel Hill, flying, 2 nights, Miami, my max is 1500, free Nov 10-14, I like the beach");
    const mason = await t.say(MASON, "I'm in, my max is 1200, free Nov 10-14, I like food");
    expect(mason.mason.join(' ')).toMatch(/your max is \$1,200/);
    expect(mason.mason.join(' ')).toMatch(/you're free Nov 10-14/);
    const clash = await t.say(MASON, 'from durham');
    expect([...clash.jeff, ...clash.mason].join(' ')).toMatch(/Mason is leaving from Durham/);
    for (const text of ['mine', 'the first one']) {
      expect((await t.say(JEFF, text)).jeff.join(' '), text).not.toMatch(/leaving from (?:Mine|The First One)/i);
    }
    await t.stop();
  });
});

describe('the demo script', () => {
  it('"can you ask mason if he has a car" then "yeah i have one" records his car and tells the asker', async () => {
    const t = await live();
    await t.say(JEFF, 'hey, mason and I want to plan a trip. leaving from chapel hill, 2 nights, nc mountains, free nov 14-16, my max is $2,000, i like hiking');
    expect((await t.say(JEFF, 'driving')).jeff.join(' ')).toMatch(/Whose car are we taking\?/);
    expect((await t.say(JEFF, 'can you ask mason if he has a car')).mason.join(' ')).toMatch(/Does anyone have a car we can take\?/);
    const answer = await t.say(MASON, 'yeah i have one');
    expect(answer.mason.join(' ')).toMatch(/there's a car/);
    expect(answer.mason.join(' ')).not.toMatch(/no car/);
    expect(answer.jeff.join(' ')).toMatch(/Mason has a car\./);
    await t.stop();
  });
});

describe('splitting the shared questions between two people', () => {
  it('whoever did not answer every shared question is asked about the plan so far before the search', async () => {
    const t = await live();
    await t.say(JEFF, "let's plan a trip");
    await t.say(MASON, 'leaving from chapel hill');
    await t.say(MASON, 'driving');
    await t.say(MASON, 'i have a car');
    await t.say(MASON, '3 nights');
    const where = await t.say(JEFF, 'Washington DC');
    expect(where.jeff.join(' ')).toMatch(/So far the idea is/);   // Jeffrey only gave the place, so he is asked about the rest
    const next = await t.say(MASON, 'free nov 14-16');               // Mason is asked about the place when he next texts (never out of the blue)
    expect(next.mason.join(' ')).toMatch(/So far the idea is.*Washington/i);
    await t.stop();
  });
  it("'10 hours' and 'I am fine driving for 10 hours maximum' answer how far they will drive", async () => {
    const { extractConstraints } = await import('../../src/conversation/constraints.js');
    const region = (t: string, pending?: 'region') => extractConstraints(t, '2026-10-11T12:00:00Z', pending).map((e) => e.value).find((v) => v.field === 'region');
    expect(region("I'm fine driving for 10 hours maximum")).toMatchObject({ field: 'region', maxTravelMinutes: 600 });
    expect(region('10 hours', 'region')).toMatchObject({ field: 'region', maxTravelMinutes: 600 });
    expect(region('4 hours tops')).toMatchObject({ field: 'region', maxTravelMinutes: 240 });
  });
});

describe('the screenshot from the phone run', () => {
  it('the same place twice is not a disagreement, asking for help keeps you moving, and "what do you need from me" lists what is missing', async () => {
    const t = await live();
    await t.say(MASON, 'lets plan a trip. leaving from chapel hill, driving, 3 nights, going to washington dc, free all of november, my max is 900, i like food');
    await t.say(JEFF, 'hey');
    const asked = await t.say(JEFF, 'Can you ask Mason if he has a car');
    expect(asked.jeff.join(' ')).toMatch(/Done, I asked Mason\..*Meanwhile, /);
    const needs = await t.say(JEFF, 'Okay great what other information do you need from me');
    expect(needs.jeff.join(' ')).toMatch(/I still need .*your free dates.*your budget/);
    const same = await t.say(JEFF, "I'm free all of November and I also want to go to Washington DC");
    expect([...same.jeff, ...same.mason].join(' ')).not.toMatch(/both thinking|Which sounds better|changed the place/);
    await t.stop();
  });
});
