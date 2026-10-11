import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, humans, lint, reachOptions, type Humans } from './harness.js';
afterEach(cleanup);
const said = (r: { all: string[] }) => r.all.join('\n');
/** The group heads-up about spending ("gas is over its budget") goes to everyone on purpose; private answers must not. */
const notNotice = (texts: string[]) => texts.filter((t) => !/simulated sandbox money/.test(t));

async function approved(h: Humans) {
  await reachOptions(h); await h.say('mason', 'pick 1');
  for (const w of ['mason', 'alex', 'jordan'] as const) await h.say(w, "I'm in");
}

describe('L. who covered what', () => {
  it('L1 before approval the answer says a plan must be approved first', async () => {
    const h = await humans({ fund: 'mock' }); await reachOptions(h);
    expect(said(await h.say('mason', 'who covered what?'))).toMatch(/approved/i); await h.stop();
  });
  it('L1 with tracking not set up it says so plainly', async () => {
    const h = await humans(); await approved(h);
    expect(said(await h.say('mason', 'who covered what?'))).toMatch(/isn't set up/i); await h.stop();
  });
  it('L1 when the bank cannot be read it says so and does not make up numbers', async () => {
    const h = await humans({ fund: 'broken' }); await approved(h);
    const r = await h.say('mason', "how's the fund?");
    expect(said(r)).toMatch(/can't reach the bank/i); expect(said(r)).not.toMatch(/\$\d/); await h.stop();
  });
  it('L2 the headline: one friend covers the whole bill, nobody splits anything, and the bot knows who is owed', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h);
    h.paid('mason', 60, 'gas');          // Mason just pays the gas for everyone
    const r = await h.say('alex', 'who paid for what?');
    expect(r.alex.length).toBeGreaterThan(0);
    expect(said(r)).toMatch(/Mason \$60/); expect(said(r)).toMatch(/Alex owes Mason \$20/); expect(said(r)).toMatch(/Jordan owes Mason \$20/);
    expect(said(r)).toMatch(/simulated/i); await h.stop();
  });
  it('L2 several people cover different things and the answer reflects the latest bank data each time', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h);
    h.paid('mason', 110, 'hotel'); const first = await h.say('mason', 'who covered what?');
    expect(said(first)).toMatch(/Mason \$110/);
    h.paid('alex', 60, 'gas'); h.paid('jordan', 30, 'parks');
    const second = await h.say('mason', 'who covered what?');
    expect(said(second)).toMatch(/Mason \$110.*Alex \$60.*Jordan \$30/); expect(said(second)).toMatch(/Fair share is about \$67 each/); await h.stop();
  });
  it('L2 status goes only to the asker, and never contains anyone\'s limit', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); h.paid('mason', 60, 'gas');
    const r = await h.say('alex', 'what do I owe?');
    expect(notNotice(r.mason.concat(r.jordan))).toEqual([]);
    expect(said(r)).not.toMatch(/\b(?:200|250|300)\b.*max|your max/i); await h.stop();
  });
  it('L2 personal food is not split, and a stranger\'s account is never credited', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h);
    h.paid('alex', 45, 'restaurant'); h.ledger.purchases.push({ id: 'x', memberId: 'stranger', amountDollars: 500, category: 'hotel', status: 'completed' });
    expect(said(await h.say('mason', 'who covered what?'))).toMatch(/Nothing shared has been covered yet/); await h.stop();
  });
  it('L3 reminders go privately to each person who owes, with their own debt only', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); h.paid('mason', 90, 'hotel');
    const r = await h.say('mason', 'remind everyone');
    expect(r.alex.join(' ')).toMatch(/you owe Mason \$30/i); expect(r.jordan.join(' ')).toMatch(/you owe Mason \$30/i);
    expect(r.alex.join(' ')).not.toMatch(/Jordan/); expect(r.mason.join(' ')).toMatch(/Reminded Alex and Jordan/); await h.stop();
  });
  it('L3 asking twice does not nag, and the next day it is allowed again', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); h.paid('mason', 90, 'hotel');
    await h.say('mason', 'remind everyone');
    const again = await h.say('mason', 'remind everyone');
    expect(again.alex.length + again.jordan.length, 'a second reminder straight away is nagging').toBe(0);
    expect(said(again)).toMatch(/already reminded/i);
    h.advance(26); const next = await h.say('mason', 'remind everyone');
    expect(next.alex.length + next.jordan.length).toBeGreaterThan(0); await h.stop();
  });
  it('L4 when everyone covered the same, there is nobody to remind', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h);
    for (const w of ['mason', 'alex', 'jordan'] as const) h.paid(w, 25, 'gas');
    const r = await h.say('mason', 'remind everyone'); expect(said(r)).toMatch(/nobody to remind/i);
    expect(notNotice(r.alex.concat(r.jordan))).toEqual([]); await h.stop();
  });
  it('L5 the wrap-up goes to everyone with who sends whom, says the bot moves no money, and keeps the simulated label', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); h.paid('mason', 120, 'hotel'); h.paid('alex', 30, 'gas');
    const r = await h.say('mason', 'wrap up the trip');
    expect(r.alex.join(' ')).toMatch(/wrap-up/i); expect(r.jordan.join(' ')).toMatch(/wrap-up/i);
    expect(said(r)).toMatch(/Jordan sends Mason \$50/); expect(said(r)).toMatch(/Alex sends Mason \$20/);
    expect(said(r)).toMatch(/don't move any money/i); expect(said(r)).toMatch(/simulated/i); expect(lint(h)).toEqual([]); await h.stop();
  });
  it('L6 only purchases from the trip period count', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h);
    h.paid('mason', 999, 'hotel', '2019-01-01');                 // long before the trip
    h.paid('mason', 60, 'gas', new Date().toISOString().slice(0, 10));
    const r = await h.say('mason', 'who covered what?');
    expect(said(r)).toMatch(/Mason \$60/); expect(said(r)).not.toMatch(/999/); await h.stop();
  });
  it('L7 money questions during planning get an honest reply, not silence', async () => {
    const h = await humans({ fund: 'mock' });
    for (const w of ['who covered what?', 'what do I owe?', 'remind everyone', 'wrap up the trip']) expect((await h.say('alex', w)).alex.length, w).toBeGreaterThan(0);
    await h.stop();
  });
});
