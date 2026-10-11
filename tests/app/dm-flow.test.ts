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
    await messenger.emit(dmEvent(from, `m${++n}`, text));
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

  it("Mason's dates question reaches only Mason's phone, never Jeffrey's, and names nobody", async () => {
    const t = await live();
    const steps = [
      await t.say(JEFF, "Hi, let's plan a trip"),
      await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I have a car, I'm free Nov 14-16, my max is $250"),
      await t.say(JEFF, 'Can you show us some options?'),
      await t.say(JEFF, 'Can you show us some options?'),
    ];
    const datesQuestion = /which dates/i;
    const toMason = steps.flatMap((r) => r.mason).filter((x) => datesQuestion.test(x));
    const toJeffrey = steps.flatMap((r) => r.jeff).filter((x) => datesQuestion.test(x));
    expect(toMason.length).toBeGreaterThan(0);   // Mason gets his question
    expect(toJeffrey).toEqual([]);               // Jeffrey already gave his dates, so he is not asked
    expect(steps.flatMap((r) => r.jeff).filter((x) => /^Mason,/.test(x))).toEqual([]); // and nothing addressed to Mason reaches him
    for (const q of toMason) expect(q).not.toMatch(/Mason|Jeffrey/); // addressed by routing, not by name
    await t.stop();
  });

  it('the very first early request already gets a private "what is missing" message, then at most two questions', async () => {
    const t = await live();
    const first = await t.say(JEFF, "Hi, let's plan a trip");
    expect(first.jeff[0]).toMatch(/still waiting on/i);          // the summary comes first, to the person who asked
    expect(first.mason.some((x) => /still waiting on/i.test(x))).toBe(false); // and only to them
    expect(questions(first.jeff).length).toBeLessThanOrEqual(2);
    await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I have a car, I'm free Nov 14-16, my max is $250");
    const options = await t.say(JEFF, 'Can you show us some options?');
    expect(options.jeff.some((x) => /still waiting on/i.test(x))).toBe(true);
    await t.stop();
  });

  it('the missing-details summary says "your" to the person it is about and names them to everyone else', async () => {
    const t = await live();
    await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights, I have a car, I'm free Nov 14-16, my max is $250");
    const toJeff = await t.say(JEFF, 'Can you show us some options?');
    const jeffSummary = toJeff.jeff.find((x) => /still waiting on/i.test(x))!;
    expect(jeffSummary).toMatch(/Mason's dates/);                // about Mason, so it names him
    expect(jeffSummary).not.toMatch(/your (dates|budget)/);      // Jeffrey has given both
    const toMason = await t.say(MASON, 'Can you show us some options?');
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
});
