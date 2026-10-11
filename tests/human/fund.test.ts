import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, humans, lint, reachOptions, type Humans } from './harness.js';
afterEach(cleanup);
const said = (r: { all: string[] }) => r.all.join('\n');

async function approved(h: Humans) {
  await reachOptions(h); await h.say('mason', 'pick 1');
  for (const w of ['mason', 'alex', 'jordan'] as const) await h.say(w, "I'm in");
}
const deposit = async (h: Humans, who: 'mason' | 'alex' | 'jordan', dollars: number) => {
  const s = await h.state();
  h.ledger.deposits.push({ id: `d${h.ledger.deposits.length + 1}`, amountDollars: dollars, description: `member=${who};rev=${s.revision}`, status: 'completed' });
};

describe('L. fund chat', () => {
  it('L1 before approval the answer says a plan must be approved first', async () => {
    const h = await humans({ fund: 'mock' }); await reachOptions(h);
    expect(said(await h.say('mason', "how's the fund?"))).toMatch(/approved/i); await h.stop();
  });
  it('L1 with no fund set up it says so plainly', async () => {
    const h = await humans(); await approved(h);
    expect(said(await h.say('mason', "how's the fund?"))).toMatch(/disabled|isn't set up|not set up/i); await h.stop();
  });
  it('L1 when the bank cannot be read it says so and does not make up numbers', async () => {
    const h = await humans({ fund: 'broken' }); await approved(h);
    const r = await h.say('mason', "how's the fund?");
    expect(said(r)).toMatch(/unavailable|couldn't|can't reach/i); expect(said(r)).not.toMatch(/\$\d/); await h.stop();
  });
  it('L2 status goes only to the asker, says who still owes, and labels the money as simulated', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); await deposit(h, 'mason', 175);
    const r = await h.say('alex', 'who still owes?');
    expect(r.alex.length).toBeGreaterThan(0); expect(r.mason.concat(r.jordan)).toEqual([]);
    expect(said(r)).toMatch(/Mason|Jordan|Alex/); expect(said(r)).toMatch(/simulated/i);
    expect(said(r)).not.toMatch(/\b(?:200|250|300)\b.*max|your max/i); await h.stop();
  });
  it('L2 a deposit tagged for an older revision does not count', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h);
    const s = await h.state();
    h.ledger.deposits.push({ id: 'old', amountDollars: 500, description: `member=mason;rev=${s.revision - 1}`, status: 'completed' });
    const r = await h.say('mason', "how's the fund?");
    expect(said(r)).not.toMatch(/Everyone|all paid|fully funded/i); await h.stop();
  });
  it('L2 reminders go privately to each person who owes, and the asker is told who', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); await deposit(h, 'mason', 175);
    const r = await h.say('mason', 'remind everyone');
    expect(r.alex.join(' ')).toMatch(/your share/i); expect(r.jordan.join(' ')).toMatch(/your share/i);
    expect(r.alex.join(' ')).not.toMatch(/Jordan|Mason/); expect(r.mason.join(' ')).toMatch(/Reminded.*(Alex|Jordan)/); await h.stop();
  });
  it('L3 asking for reminders twice in a row does not text the same person again immediately', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h);
    await h.say('mason', 'remind everyone'); const again = await h.say('mason', 'remind everyone');
    expect(again.alex.length + again.jordan.length, 'a second reminder straight away is nagging').toBe(0); await h.stop();
  });
  it('L3 a reminder is allowed again the next day, and the asker is told when nobody is due', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h);
    await h.say('mason', 'remind everyone');
    expect(said(await h.say('mason', 'remind everyone'))).toMatch(/already reminded/i);
    h.advance(26); const next = await h.say('mason', 'remind everyone');
    expect(next.alex.length + next.jordan.length).toBeGreaterThan(0); await h.stop();
  });
  it('L4 when everyone has paid there is nobody to remind', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h);
    for (const w of ['mason', 'alex', 'jordan'] as const) await deposit(h, w, 400);
    const r = await h.say('mason', 'remind everyone'); expect(said(r)).toMatch(/nobody to remind|covered/i);
    expect(r.alex.concat(r.jordan)).toEqual([]); await h.stop();
  });
  it('L5 the wrap-up goes to the group, says the bot moves no money, and keeps simulated labels', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h);
    for (const w of ['mason', 'alex', 'jordan'] as const) await deposit(h, w, 200);
    const r = await h.say('mason', 'wrap up the trip');
    expect(r.alex.join(' ')).toMatch(/wrap-up/i); expect(r.jordan.join(' ')).toMatch(/wrap-up/i);
    expect(said(r)).toMatch(/don't move any money/i); expect(said(r)).toMatch(/simulated/i); expect(lint(h)).toEqual([]); await h.stop();
  });
  it('L6 fund questions from a person still in planning get an honest reply, not silence', async () => {
    const h = await humans({ fund: 'mock' });
    for (const w of ["how's the fund?", 'who still owes?', 'remind everyone', 'wrap up the trip']) expect((await h.say('alex', w)).alex.length, w).toBeGreaterThan(0);
    await h.stop();
  });
});
