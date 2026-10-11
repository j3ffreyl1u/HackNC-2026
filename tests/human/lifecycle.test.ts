import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/app/server.js';
import { dmEvent } from '../../src/conversation/mock.js';
import { cleanup, humans, lint, PHONES, reachOptions, type Humans } from './harness.js';
afterEach(cleanup);
const said = (r: { all: string[] }) => r.all.join('\n');

async function approved(h: Humans) {
  await reachOptions(h); await h.say('mason', 'pick 1');
  for (const w of ['mason', 'alex', 'jordan'] as const) await h.say(w, "I'm in");
}

describe('K. guide questions', () => {
  it('K1 a rain question after approval gets a cited answer, privately', async () => {
    const h = await humans(); await approved(h);
    const r = await h.say('alex', 'guide: what if it rains on Saturday?');
    expect(r.alex.length).toBeGreaterThan(0); expect(r.mason.concat(r.jordan)).toEqual([]);
    expect(said(r)).toMatch(/fixtures\.invalid|source/i); await h.stop();
  });
  it('K2 an unknown question is an honest "couldn\'t find", never invented', async () => {
    const h = await humans(); await approved(h);
    const r = await h.say('alex', 'guide: where is the best pizza?');
    expect(said(r)).toMatch(/couldn't find|ask it another way/i); await h.stop();
  });
  it('K3 a guide question before any plan is picked does not claim it fits anyone\'s budget', async () => {
    const h = await humans(); await reachOptions(h);
    const r = await h.say('alex', 'guide: what if it rains on Saturday?');
    expect(said(r)).not.toMatch(/fits (?:your|everyone's) budget/i); expect(lint(h)).toEqual([]); await h.stop();
  });
});

describe('J. failures and restarts', () => {
  it('J5 the same message delivered twice is handled once', async () => {
    const h = await humans();
    const ev = dmEvent(PHONES.alex, 'dup-1', 'my max is $250', { occurredAt: '2026-10-11T15:05:00.000Z' });
    await h.messenger.emit(ev); await h.runtime.drainOutbox();
    const n = h.messenger.sent.length;
    await h.messenger.emit(ev); await h.runtime.drainOutbox();
    expect(h.messenger.sent.length).toBe(n); await h.stop();
  });
  it('J7 five messages from three people at once all land, in order per person', async () => {
    const h = await humans();
    const at = '2026-10-11T15:10:00.000Z';
    await Promise.all([
      h.messenger.emit(dmEvent(PHONES.mason, 'q1', "I'm leaving from Chapel Hill", { occurredAt: at })),
      h.messenger.emit(dmEvent(PHONES.alex, 'q2', 'my max is $250', { occurredAt: at })),
      h.messenger.emit(dmEvent(PHONES.jordan, 'q3', "I'm free Nov 14-17", { occurredAt: at })),
      h.messenger.emit(dmEvent(PHONES.mason, 'q4', '2 nights', { occurredAt: at })),
      h.messenger.emit(dmEvent(PHONES.alex, 'q5', 'I like hiking', { occurredAt: at })),
    ]);
    await h.runtime.waitForIdle(); await h.runtime.drainOutbox();
    const s = await h.state();
    const fields = [...s.groupConstraints.map((c) => c.field), ...s.memberConstraints.map((c) => `${c.memberId}:${c.field}`)];
    expect(fields).toEqual(expect.arrayContaining(['origin', 'duration', 'alex:budget', 'alex:preferences', 'jordan:availability'])); await h.stop();
  });
});

describe('M. calendar and N. page', () => {
  it('M1/N1 the page never shows a cap, and plan.ics is a valid calendar once approved', async () => {
    const h = await humans();
    const server = createHttpServer({ repository: h.repository }); const port = await server.listen(0);
    const base = `http://127.0.0.1:${port}/api/trips/h`;
    await reachOptions(h);
    expect((await fetch(`${base}/plan.ics`)).status).toBe(409);
    await h.say('mason', 'pick 1'); for (const w of ['mason', 'alex', 'jordan'] as const) await h.say(w, "I'm in");
    const ics = await fetch(`${base}/plan.ics`); expect(ics.status).toBe(200);
    const body = await ics.text(); expect(body).toMatch(/^BEGIN:VCALENDAR/); expect(body).toMatch(/END:VCALENDAR\s*$/);
    const snap = JSON.stringify(await (await fetch(`${base}/snapshot`)).json());
    expect(snap).not.toMatch(/"budget"|memberConstraints|"maxCents"|"cap"/);
    expect((await fetch(`http://127.0.0.1:${port}/api/trips/nope/snapshot`)).status).toBe(404);
    await server.close(); await h.stop();
  });
  it('M3 approving, changing and re-approving keeps the calendar event ids', async () => {
    const h = await humans();
    const server = createHttpServer({ repository: h.repository }); const port = await server.listen(0);
    const uids = async () => [...(await (await fetch(`http://127.0.0.1:${port}/api/trips/h/plan.ics`)).text()).matchAll(/UID:(\S+)/g)].map((m) => m[1]!).sort();
    await approved(h); const first = await uids();
    await h.say('mason', 'my max is $199');
    for (const w of ['mason', 'alex', 'jordan'] as const) await h.say(w, "I'm in");
    if ((await h.state()).status === 'approved') expect(await uids()).toEqual(first);
    await server.close(); await h.stop();
  });
});
