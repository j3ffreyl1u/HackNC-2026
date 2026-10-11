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

/** The real pieces (A's parser + C's runtime + B's planner) over a mock phone line, in direct (one-on-one) mode. */
async function live() {
  const dir = mkdtempSync(join(tmpdir(), 'dm-flow-')); dirs.push(dir);
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
  /** Send one DM and return exactly what the bot texted back to each person because of it. */
  const say = async (from: string, text: string) => {
    const before = messenger.sent.length;
    await messenger.emit(dmEvent(from, `m${++n}`, text, { occurredAt: new Date(Date.parse('2026-10-01T12:00:00Z') + n * 20_000).toISOString() }));   // people take a few seconds between texts
    await runtime.drainOutbox();
    const out = messenger.sent.slice(before);
    const to = (who: string) => out.filter((s) => s.audience.kind === 'private' && s.audience.providerUserId === who).map((s) => s.text);
    return { jeff: to(JEFF), mason: to(MASON), all: out.map((s) => s.text) };
  };
  const state = async () => (await repository.loadTrip('dm'))!;
  return { say, state, stop: async () => { await runtime.stop(); repository.close(); } };
}
const questions = (texts: string[]) => texts.filter((t) => t.trim().endsWith('?'));

describe('first live DM scenario, end to end (A parser + C runtime + B planner, mock phone line)', () => {
  it('starting a trip asks at most two questions per person', async () => {
    const t = await live();
    const r = await t.say(JEFF, "Hi, let's plan a trip");
    expect(r.jeff.length).toBeGreaterThan(0);
    expect(questions(r.jeff).length).toBeLessThanOrEqual(2);
    expect(questions(r.mason).length).toBeLessThanOrEqual(2);
    await t.stop();
  });

  it('a message with many facts is fully saved and none of it is asked again', async () => {
    const t = await live();
    await t.say(JEFF, "Hi, let's plan a trip");
    const r = await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I’ve got a car, I'm free Nov 14-16, my max is $250, I like hiking and a town visit");
    const s = await t.state();
    const mine = s.memberConstraints.filter((c) => c.memberId === 'jeffrey').map((c) => c.field);
    expect(mine).toEqual(expect.arrayContaining(['budget', 'availability', 'preferences']));
    expect(s.groupConstraints.map((c) => c.field)).toEqual(expect.arrayContaining(['origin', 'duration', 'transport']));
    const said = r.all.join('\n');
    expect(said).not.toMatch(/leaving from\?|how many nights|have a car/i); // answered, so not re-asked
    expect(r.jeff.join('\n')).toMatch(/Got it/);                           // and acknowledged
    expect(questions(r.jeff).length).toBeLessThanOrEqual(2);
    await t.stop();
  });

  it('an options request with gaps is never met with silence, and no budget is ever shown to anyone', async () => {
    const t = await live();
    await t.say(JEFF, "Hi, let's plan a trip");
    await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I have a car, I'm free Nov 14-16, my max is $250");
    const first = await t.say(JEFF, 'Can you show us some options?');
    expect(first.jeff.length).toBeGreaterThan(0);              // never silent
    expect(questions(first.jeff).length).toBeLessThanOrEqual(2);
    const again = await t.say(JEFF, 'Can you show us some options?');
    expect(again.jeff.some((x) => /still waiting on/i.test(x) && /Mason/.test(x))).toBe(true); // says what is missing
    for (const text of [...first.all, ...again.all]) expect(text).not.toMatch(/\$\s?250|25000|250\.00/);
    await t.stop();
  });

  it('two people saying "let\'s plan a trip" at once get ONE shared question between them, not a flood', async () => {
    const t = await live();
    const jeff = await t.say(JEFF, "Hey let's plan a trip");
    const mason = await t.say(MASON, "Hey let's plan a trip");     // a few seconds later
    // Jeffrey: exactly one question, and it is not copied to Mason's phone.
    expect(jeff.jeff).toEqual(['Where are you all leaving from?']);
    expect(jeff.mason).toEqual([]);
    // Mason's own request: the work is split. Jeffrey already has the shared question, so Mason is asked his own side (his dates).
    expect(mason.mason).toEqual(['Which dates could you do for the trip?']);
    expect(mason.jeff).toEqual([]);
    await t.stop();
  });

  it('after "Got it", the next question follows, one at a time, until the basics are done', async () => {
    const t = await live();
    await t.say(JEFF, "Hey let's plan a trip");
    const asked: string[] = [];
    for (const answer of ["I'm leaving from Chapel Hill", '2 nights', 'I want to go to Asheville', 'I have a car']) {
      const r = await t.say(JEFF, answer);
      expect(r.jeff.some((x) => /^Got it/.test(x)), answer).toBe(true);       // acknowledged
      expect(questions(r.jeff).length, answer).toBeLessThanOrEqual(1);         // never more than one question
      asked.push(...questions(r.jeff));
    }
    expect(asked[0]).toMatch(/nights/i);                                       // the conversation keeps moving
    await t.stop();
  });

  it('"Got it" always comes BEFORE the next question in the same turn', async () => {
    const t = await live();
    await t.say(JEFF, "Hey let's plan a trip");
    for (const answer of ["I'm leaving from Chapel Hill", '2 nights', 'I want to go to Asheville', 'I have a car']) {
      const r = await t.say(JEFF, answer);
      const ackAt = r.jeff.findIndex((x) => /^Got it/.test(x));
      const questionAt = r.jeff.findIndex((x) => x.trim().endsWith('?'));
      expect(ackAt, answer).toBeGreaterThanOrEqual(0);
      if (questionAt >= 0) expect(ackAt, answer).toBeLessThan(questionAt);
    }
    await t.stop();
  });

  it("Mason's own dates question comes only to Mason, once the shared basics are settled, and names nobody", async () => {
    const t = await live();
    const steps = [
      await t.say(JEFF, "Hey let's plan a trip"),
      await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I have a car, I want to go to Asheville, I'm free Nov 14-16, my max is $250, I like hiking"),
    ];
    // Mason is not texted out of the blue while Jeffrey answers ...
    expect(steps.flatMap((r) => r.mason)).toEqual([]);
    // ... but the moment he starts talking, he is asked whether the plan so far works for him (that names Jeffrey, who started it) ...
    steps.push(await t.say(MASON, 'I want to plan a trip'));
    expect(steps.flatMap((r) => r.mason).some((x) => /^Hey Mason! Jeffrey started planning a trip with you\. So far the idea is leaving from Chapel Hill for 2 nights, going to Asheville, with a car\. Does that work for you/i.test(x))).toBe(true);
    steps.push(await t.say(MASON, 'yes that works'));
    // ... and only then his own dates question, one at a time.
    const datesQuestion = /which dates/i;
    const toMason = steps.flatMap((r) => r.mason).filter((x) => datesQuestion.test(x));
    const toJeffrey = steps.flatMap((r) => r.jeff).filter((x) => datesQuestion.test(x));
    expect(toMason.length).toBeGreaterThan(0);   // Mason gets his question
    expect(toJeffrey).toEqual([]);               // Jeffrey already gave his dates, so he is not asked
    for (const q of toMason) expect(q).not.toMatch(/Mason|Jeffrey/);
    expect(steps.flatMap((r) => r.jeff).filter((x) => /^Mason,/.test(x))).toEqual([]);
    await t.stop();
  });

  it('the very first request gets exactly one question, and only the asker hears anything', async () => {
    const t = await live();
    const first = await t.say(JEFF, "Hi, let's plan a trip");
    expect(first.jeff).toEqual(['Where are you all leaving from?']);   // no preamble, no checklist
    expect(first.mason).toEqual([]);                                      // and nothing copied to the other phone
    await t.stop();
  });

  it('the missing-details summary says "your" to the person it is about and names them to everyone else', async () => {
    const t = await live();
    await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I have a car, I'm free Nov 14-16, my max is $250");
    await t.say(JEFF, 'Can you show us some options?');                    // first he is asked the next open question
    const toJeff = await t.say(JEFF, 'Can you show us some options?');     // asking again gets the recap
    const jeffSummary = toJeff.jeff.find((x) => /still waiting on/i.test(x))!;
    expect(jeffSummary).toMatch(/Mason's dates/);                // about Mason, so it names him
    expect(jeffSummary).not.toMatch(/your (dates|budget)/);      // Jeffrey has given both
    await t.say(MASON, 'Can you show us some options?');                   // first he is asked his own dates question
    const toMason = await t.say(MASON, 'Can you show us some options?');   // asking again gets the recap
    const masonSummary = toMason.mason.find((x) => /still waiting on/i.test(x))!;
    expect(masonSummary).toMatch(/your dates/);                  // about Mason, so it says "your"
    expect(masonSummary).not.toMatch(/Mason's/);
    await t.stop();
  });

  it('the exact messages from the first two-phone live run are understood and every one gets a reply', async () => {
    const t = await live();
    await t.say(JEFF, "Hi, let's plan a trip");
    await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I have a car, I'm free Nov 14-16, my max is $250, I like hiking and a town visit");
    const dest = await t.say(JEFF, 'I want to go to Washington DC from North Carolina.');
    expect(dest.jeff.join(' ')).not.toMatch(/you're into Washington/);          // it is a destination, not a preference
    expect((await t.state()).groupConstraints.some((c) => c.field === 'region')).toBe(true);
    for (const text of ['Nope', "No, that's not right", "Yes that's right"]) {
      const r = await t.say(JEFF, text);
      expect(r.jeff.length, text).toBeGreaterThan(0);                            // never silence
    }
    const mason = await t.say(MASON, 'I want to go to Washington. I can drive any distance');
    expect(mason.mason.join(' ')).not.toMatch(/you're into/);
    await t.stop();
  });

  it('later preferences add to earlier ones, and "no preference" resets them', async () => {
    const t = await live();
    await t.say(JEFF, "Hi, let's plan a trip");
    await t.say(JEFF, 'I like hiking and a town visit');
    await t.say(JEFF, 'I want to be able to visit a bunch of historical places.');
    const prefs = async () => (await t.state()).memberConstraints.filter((c) => c.memberId === 'jeffrey' && c.field === 'preferences');
    const all = JSON.stringify((await prefs()).map((c) => c.value));
    expect(all).toMatch(/hiking/);
    expect(all).toMatch(/historical/);
    await t.say(JEFF, 'no preference, I’m easy');
    const after = await prefs();
    expect(JSON.stringify(after[after.length - 1]!.value)).toMatch(/no preference/);
    await t.stop();
  });

  it('dates that never overlap are explained to BOTH people, with who is free when', async () => {
    const t = await live();
    await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I want to go to Asheville, I have a car, I'm free Dec 20-31, my max is $500, I like hiking");
    const r = await t.say(MASON, "I'm free Nov 14-17, my max is $500, I like food");   // the clash is announced the moment it exists
    for (const who of [r.jeff, r.mason]) {
      expect(who.some((x) => /Jeffrey is free Dec 20-31/.test(x) && /Mason is free Nov 14-17/.test(x) && /no 2 nights stretch/i.test(x))).toBe(true);
    }
    await t.stop();
  });

  it('starts looking for options on its own once the last detail is in, and tells both people', async () => {
    const t = await live();
    const jeff = await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I want to go to Asheville, I have a car, I'm free Nov 14-17, my max is $500, I like hiking");
    expect(jeff.mason).toEqual([]);                                                   // Mason is not texted out of the blue
    const first = await t.say(MASON, "I'm free Nov 14-17, my max is $500, I like food");
    expect(first.mason.some((x) => /Does that work for you/i.test(x))).toBe(true);    // he is asked about the basics when he speaks up
    expect((await t.state()).status).toBe('gathering');                              // and the search waits for his answer
    const r = await t.say(MASON, 'sounds good');
    expect(r.jeff.some((x) => /looking up options now/i.test(x))).toBe(true);
    expect(r.mason.some((x) => /looking up options now/i.test(x))).toBe(true);
    expect((await t.state()).revision).toBeGreaterThan(1);   // the search ran (the mock data has no Asheville trip, so it reports that)
    await t.stop();
  });

  it("when Jeffrey asks for options and Mason's details are missing, Mason is messaged for them (once), and Jeffrey is told", async () => {
    const t = await live();
    await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I want to go to Asheville, I have a car, I'm free Nov 14-17, my max is $500, I like hiking");
    const ask = await t.say(JEFF, 'show us some options');
    expect(ask.mason.length).toBe(1);
    expect(ask.mason[0]).toMatch(/^Hey Mason! Jeffrey is ready to see trip options and is just waiting on your /);
    expect(questions(ask.mason).length).toBe(1);                                      // one question, so it is easy to answer
    expect(ask.mason[0]).not.toMatch(/\$|500/);                                       // nobody's budget is in it
    expect(ask.jeff.some((x) => /nudge Mason/i.test(x))).toBe(true);                  // Jeffrey knows it was passed on
    const again = await t.say(JEFF, 'show us some options');
    expect(again.mason).toEqual([]);                                                  // not nagged again straight away
    await t.stop();
  });

  it('"what did Mason say?" is answered from what Mason told the bot, and never includes his budget', async () => {
    const t = await live();
    await t.say(MASON, "I'm free Nov 14-17, my max is $777, I like food and museums");
    const r = await t.say(JEFF, 'what did Mason say?');
    const answer = r.jeff.join(' ');
    expect(answer).toMatch(/Mason is free Nov 14-17 and is into food and museums/);
    expect(answer).not.toMatch(/777|\$/);
    await t.stop();
  });

  it('a date clash asks the person with more room, by name, to flex to the other\'s dates', async () => {
    const t = await live();
    await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I want to go to Asheville, I have a car, I'm free Dec 20-31, my max is $500, I like hiking");
    const r = await t.say(MASON, "I'm free Nov 14-17, my max is $500, I like food");
    for (const who of [r.jeff, r.mason]) expect(who.some((x) => /Jeffrey, since you've got more room, any chance you could do Nov 14-17\?/.test(x))).toBe(true);
    await t.stop();
  });
});
