import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, humans, lint, reachOptions, type Humans } from './harness.js';
afterEach(cleanup);
const said = (r: { all: string[] }) => r.all.join('\n');

async function approved(h: Humans) {
  await reachOptions(h); await h.say('mason', 'pick 1');
  for (const w of ['mason', 'alex', 'jordan'] as const) await h.say(w, "I'm in");
}
/** Sends whatever the periodic bank check would send, and returns what each person was told. */
async function check(h: Humans) {
  const before = h.messenger.sent.length;
  await h.runtime.checkPurchases(); await h.runtime.drainOutbox();
  const out = h.messenger.sent.slice(before);
  return { all: out.map((m) => m.text), count: out.length };
}

const notice = (r: { all: string[] }) => r.all.filter((t) => /didn't budget|over its budget/.test(t));

describe('M. checking odd bank purchases with the buyer', () => {
  it('M1 a purchase the plan explains is counted and nobody is asked anything', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h);
    h.paid('mason', 110, 'hotel'); h.paid('alex', 25, 'gas'); h.paid('alex', 45, 'restaurant');
    expect((await check(h)).count).toBe(0); await h.stop();
  });
  it('M2 an unrecognised purchase asks only the buyer, once, privately, and says what it is about', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); h.paid('jordan', 80, 'casino');
    const before = h.messenger.sent.length;
    const first = await check(h);
    expect(first.count).toBe(1);
    const sent = h.messenger.sent.slice(before)[0]!;
    expect(sent.audience.kind === 'private' && sent.audience.providerUserId).toBeTruthy();
    expect(first.all[0]).toMatch(/\$80/); expect(first.all[0]).toMatch(/trip/i); expect(first.all[0]).toMatch(/personal/i);
    expect(first.all[0]).not.toMatch(/\b(max|cap|budget)\b.*\$\d/i);
    expect((await check(h)).count).toBe(0); await h.stop();
  });
  it('M3 "trip" counts it as shared; the others see it in who covered what', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); h.paid('jordan', 80, 'casino');
    const asked = await check(h); expect(asked.count).toBe(1);
    expect(said(await h.say('mason', 'who covered what?'))).toMatch(/\$80.*(waiting|isn't counted|not counted)/i);
    const r = await h.say('jordan', 'trip'); expect(said(r)).toMatch(/counting|shared/i);
    const after = await h.say('mason', 'who covered what?'); expect(said(after)).toMatch(/Jordan \$80/); await h.stop();
  });
  it('M3b once the buyer says it was for the trip, nobody also gets a "not budgeted" heads-up about it', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); h.paid('jordan', 80, 'casino'); await check(h);
    await h.say('jordan', 'trip'); const r = await h.say('mason', 'who covered what?');
    expect(notice(r)).toEqual([]); expect(said(r)).toMatch(/Jordan \$80/); await h.stop();
  });
  it('M4 "no" keeps it personal and out of the split', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); h.paid('jordan', 80, 'casino'); await check(h);
    const r = await h.say('jordan', 'no'); expect(said(r)).toMatch(/personal|leave it out|left out/i);
    expect(said(await h.say('mason', 'who covered what?'))).not.toMatch(/Jordan \$80/);
    expect((await check(h)).count).toBe(0); await h.stop();
  });
  it('M5 two odd purchases by one person are asked one at a time, never in a burst', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); h.paid('jordan', 80, 'casino'); h.paid('jordan', 55, 'spa');
    expect((await check(h)).count).toBe(1); expect((await check(h)).count).toBe(0);
    await h.say('jordan', 'trip'); const next = await check(h); expect(next.count).toBe(1); expect(next.all[0]).toMatch(/\$55/); await h.stop();
  });
  it('M6 a yes with no question open is not taken as an answer', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); h.paid('jordan', 80, 'casino');
    await h.say('jordan', 'yes'); expect(said(await h.say('mason', 'who covered what?'))).not.toMatch(/Jordan \$80/);
    expect((await check(h)).count).toBe(1); await h.stop();
  });
  it('M7 nothing is asked before the plan is approved or while the bank cannot be read', async () => {
    const h = await humans({ fund: 'mock' }); await reachOptions(h); h.paid('jordan', 80, 'casino');
    expect((await check(h)).count).toBe(0); await h.stop();
    const b = await humans({ fund: 'broken' }); await approved(b);
    await expect(b.runtime.checkPurchases()).resolves.toBeUndefined(); expect((await check(b)).count).toBe(0); await b.stop();
  });
  it('M8 the questions follow the house rules for messages', async () => {
    const h = await humans({ fund: 'mock' }); await approved(h); h.paid('alex', 90, 'casino'); await check(h);
    expect(lint(h)).toEqual([]); await h.stop();
  });
});
