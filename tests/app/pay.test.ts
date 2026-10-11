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
import { createFundService } from '../../src/funding/service.js';
import { depositTag } from '../../src/planning/funding.js';
import { defaultFixtures } from '../../src/research/fixtures.js';
import { createResearchProvider } from '../../src/research/provider.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';

const JEFF = '+15550000001';
const MASON = '+15550000002';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real conversation, runtime and planner over a mock phone line with two enrolled people. */
async function live() {
  const dir = mkdtempSync(join(tmpdir(), 'pay-')); dirs.push(dir);
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
  const ledger: { deposits: Array<{ id: string; amountDollars: number; description: string; status: string }>; purchases: Array<{ id: string; amountDollars: number; category: string; status: string }> } = { deposits: [], purchases: [] };
  const fund = Object.assign(createFundService({ read: async () => ({ deposits: ledger.deposits, purchases: ledger.purchases }) }, 'mock', undefined, { cacheMs: 0 }), {
    purchase: async (category: string, dollars: number) => { ledger.purchases.push({ id: `p${ledger.purchases.length + 1}`, amountDollars: dollars, category, status: 'completed' }); },
    deposit: async (memberId: string, dollars: number, revision: number) => { ledger.deposits.push({ id: `d${ledger.deposits.length + 1}`, amountDollars: dollars, description: depositTag(memberId, revision), status: 'completed' }); },
  });
  const runtime = createApplicationRuntime({ repository, conversation: chat.conversation, planner, tripId: 'dm', fundService: fund });
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
  return { ledger, say, stop: async () => { await runtime.stop(); repository.close(); } };
}

const START = "I'm leaving from Chapel Hill, 2 nights, NC mountains, I have a car, I'm free Nov 14-17, my max is $340, I like hiking";

async function approvedTrip() {
  const t = await live();
  await t.say(JEFF, START);
  for (const m of ['hey', 'sounds good', "I'm free Nov 14-17, my max is $310, I like food"]) await t.say(MASON, m);
  await t.say(JEFF, 'option 1'); await t.say(JEFF, "I'm in"); await t.say(MASON, "I'm in");
  return t;
}

describe('paying into the simulated fund from the chat', () => {
  it('"pay my share" asks first, then a yes adds the deposit and the fund shows it', async () => {
    const t = await approvedTrip();
    expect((await t.say(JEFF, "how's the fund?")).jeff.join(' ')).toMatch(/\$0 of \$470/);
    const ask = await t.say(JEFF, 'pay my share');
    expect(ask.jeff.join(' ')).toMatch(/Add \$235 to the trip fund\? This is simulated sandbox money\. Say "yes" to confirm\./);
    expect(t.ledger.deposits).toEqual([]);                      // nothing added before the yes
    const done = await t.say(JEFF, 'yes');
    expect(done.jeff.join(' ')).toMatch(/Done, \$235 is in the trip fund/);
    expect(t.ledger.deposits).toHaveLength(1);
    expect(t.ledger.deposits[0]!.description).toMatch(/^member=jeffrey;rev=\d+$/);
    const after = await t.say(MASON, 'who still owes?');
    expect(after.mason.join(' ')).toMatch(/\$235 of \$470/);
    expect(after.mason.join(' ')).toMatch(/Still waiting on Mason \(\$235\)/);
    await t.stop();
  });

  it('a specific amount works ("chip in $50")', async () => {
    const t = await approvedTrip();
    expect((await t.say(MASON, 'chip in $50')).mason.join(' ')).toMatch(/Add \$50 to the trip fund\?/);
    await t.say(MASON, 'yes');
    expect(t.ledger.deposits.map((d) => d.amountDollars)).toEqual([50]);
    await t.stop();
  });

  it('covering someone else puts it under their name and tells them', async () => {
    const t = await approvedTrip();
    expect((await t.say(JEFF, "pay Mason's share")).jeff.join(' ')).toMatch(/Add \$235 for Mason to the trip fund\?/);
    const done = await t.say(JEFF, 'yes');
    expect(done.jeff.join(' ')).toMatch(/Done, I put \$235 in for Mason/);
    expect(done.mason.join(' ')).toMatch(/Jeffrey covered \$235 of your share/);
    expect(t.ledger.deposits[0]!.description).toMatch(/^member=mason;/);
    await t.stop();
  });

  it('a no, or any other message, cancels it and adds nothing', async () => {
    const t = await approvedTrip();
    await t.say(JEFF, 'pay my share');
    expect((await t.say(JEFF, 'no')).jeff.join(' ')).toMatch(/I didn't add anything/);
    await t.say(JEFF, 'pay my share');
    await t.say(JEFF, "how's the fund?");
    await t.say(JEFF, 'yes');                                   // too late: the question was dropped
    expect(t.ledger.deposits).toEqual([]);
    await t.stop();
  });

  it('someone else saying yes does not confirm your payment', async () => {
    const t = await approvedTrip();
    await t.say(JEFF, 'pay my share');
    await t.say(MASON, 'yes');
    expect(t.ledger.deposits).toEqual([]);
    await t.stop();
  });

  it('says so when you are already paid up', async () => {
    const t = await approvedTrip();
    await t.say(JEFF, 'pay my share'); await t.say(JEFF, 'yes');
    expect((await t.say(JEFF, 'pay my share')).jeff.join(' ')).toMatch(/all paid up/);
    await t.stop();
  });

  it('cannot pay before a plan is approved', async () => {
    const t = await live();
    await t.say(JEFF, START);
    const r = await t.say(JEFF, 'pay my share');
    expect(r.jeff.join(' ')).toMatch(/approved/i);
    expect(t.ledger.deposits).toEqual([]);
    await t.stop();
  });

  it('"fresh restart" wipes the trip for both people, drops a pending payment, and lets them start over', async () => {
    const t = await approvedTrip();
    await t.say(JEFF, 'pay my share');                         // a payment is waiting for a yes
    const reset = await t.say(MASON, 'fresh restart');
    expect(reset.mason.join(' ')).toMatch(/Fresh start! I cleared everything/);
    expect(reset.jeff.join(' ')).toMatch(/Fresh start! Mason cleared the trip/);
    expect((await t.say(JEFF, "how's the fund?")).jeff.join(' ')).toMatch(/approved by everyone/);
    await t.say(JEFF, 'yes');                                  // the old payment question is gone
    expect(t.ledger.deposits).toEqual([]);
    const status = await t.say(JEFF, "what's the status?");
    expect(status.jeff.join(' ')).not.toMatch(/approved/i);
    // and a new trip can be planned straight away
    const again = await t.say(JEFF, "I'm leaving from Chapel Hill, 2 nights");
    expect(again.jeff.join(' ')).toMatch(/leaving from Chapel Hill/);
    await t.stop();
  });

  it('"Fresh Restart!" works with any capitals, but a sentence that merely contains it does not', async () => {
    const t = await approvedTrip();
    expect((await t.say(JEFF, 'Fresh Restart!')).jeff.join(' ')).toMatch(/Fresh start/);
    const t2 = await approvedTrip();
    expect((await t2.say(JEFF, 'should we do a fresh restart?')).jeff.join(' ')).not.toMatch(/Fresh start! I cleared/);
    await t.stop(); await t2.stop();
  });

  it('"I paid my share" explains that only the fund counts', async () => {
    const t = await approvedTrip();
    expect((await t.say(JEFF, 'I paid my share')).jeff.join(' ')).toMatch(/Say "pay my share"/);
    expect(t.ledger.deposits).toEqual([]);
    await t.stop();
  });

  describe('spending from the simulated fund', () => {
    it('"I spent $60 on gas" asks first, then a yes logs the purchase and the fund shows it', async () => {
      const t = await approvedTrip();
      const ask = await t.say(JEFF, 'I spent $60 on gas');
      expect(ask.jeff.join(' ')).toMatch(/Log \$60 on gas, parking and tolls against the trip fund\? This is simulated sandbox money\. Say "yes" to confirm\./);
      expect(t.ledger.purchases).toEqual([]);
      expect((await t.say(JEFF, 'yes')).jeff.join(' ')).toMatch(/Done, \$60 on gas, parking and tolls is logged against the trip fund/);
      expect(t.ledger.purchases).toEqual([{ id: 'p1', amountDollars: 60, category: 'fuel_parking_tolls', status: 'completed' }]);
      expect((await t.say(MASON, "how's the fund?")).mason.join(' ')).toMatch(/\$60 spent so far/);
      await t.stop();
    });

    it.each([
      ['we paid 297 for the hotel', 297, 'accommodation'], ['bought food for $40', 40, 'food'], ['the hotel cost $297', 297, 'accommodation'], ['log $20 for parking', 20, 'fuel_parking_tolls'],
      ['I spent $50 on dinner', 50, 'food'], ['spent 35 on tickets', 35, 'activities'], ["I just paid $12 for the toll", 12, 'fuel_parking_tolls'], ['record an expense of $80 for the cabin', 80, 'accommodation'],
    ])('"%s" logs $%i as %s', async (text, dollars, category) => {
      const t = await approvedTrip();
      await t.say(JEFF, text as string);
      await t.say(JEFF, 'yes');
      expect(t.ledger.purchases.map((p) => [p.amountDollars, p.category])).toEqual([[dollars, category]]);
      await t.stop();
    });

    it('"I spent money" and "I spent $50" ask what it was for instead of guessing', async () => {
      const t = await approvedTrip();
      expect((await t.say(JEFF, 'I spent money')).jeff.join(' ')).toMatch(/How much was it, and what was it for\?/);
      expect((await t.say(JEFF, 'I spent $50')).jeff.join(' ')).toMatch(/What was the \$50 for\?/);
      expect(t.ledger.purchases).toEqual([]);
      await t.stop();
    });

    it('a no cancels it, and logging is refused before a plan is approved', async () => {
      const t = await approvedTrip();
      await t.say(JEFF, 'I spent $60 on gas');
      expect((await t.say(JEFF, 'no')).jeff.join(' ')).toMatch(/I didn't add anything/);
      await t.say(JEFF, 'yes');
      expect(t.ledger.purchases).toEqual([]);
      const early = await live();
      await early.say(JEFF, START);
      expect((await early.say(JEFF, 'I spent $60 on gas')).jeff.join(' ')).toMatch(/approved/i);
      await t.stop(); await early.stop();
    });

    it('budget messages are never read as spending', async () => {
      const t = await approvedTrip();
      for (const text of ['my max is $450', 'the budget is $300', 'I can spend 200 total']) {
        const r = await t.say(JEFF, text);
        expect(r.jeff.join(' '), text).not.toMatch(/Log \$|What was the/);
      }
      await t.stop();
    });
  });
});
