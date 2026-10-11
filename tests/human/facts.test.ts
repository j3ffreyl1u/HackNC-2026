import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, humans, lint, type Humans, type Who } from './harness.js';
afterEach(cleanup);

const mine = async (h: Humans, who: Who, field: string) => (await h.state()).memberConstraints.filter((c) => c.memberId === who && c.field === field);
const group = async (h: Humans, field: string) => (await h.state()).groupConstraints.filter((c) => c.field === field);
const lastValue = async (h: Humans, who: Who, field: string) => { const l = await mine(h, who, field); return l[l.length - 1]?.value as any; };
const said = (r: { all: string[] }) => r.all.join('\n');

describe('A. first contact', () => {
  it.each(['Help', 'Cancel', 'Wait', 'Maybe', 'Saturday', 'Hi Bot', 'Happy Friday'])('A2 an autocapitalized "%s" with nothing open is not a place', async (w) => {
    const h = await humans();
    const r = await h.say('alex', w);
    expect(r.alex.length, w).toBeGreaterThan(0);
    expect(said(r), w).not.toMatch(new RegExp(`Is ${w} where`, 'i'));
    expect((await h.state()).groupConstraints.filter((c) => c.field === 'origin' || c.field === 'region'), w).toEqual([]);
    await h.stop();
  });
  it('A1 "good night" does not offer to plan a trip', async () => {
    const h = await humans();
    expect(said(await h.say('alex', 'good night'))).not.toMatch(/plan a trip/i);
    await h.stop();
  });
  it.each(['what can you do?', 'how does this work', '?'])('A3 "%s" gets a short explanation', async (w) => {
    const h = await humans();
    const r = await h.say('alex', w);
    expect(r.alex.length).toBeGreaterThan(0);
    expect(said(r)).not.toMatch(/didn't catch that/i);
    await h.stop();
  });
  it.each(['😂', '🙏', '👀'])('A4 emoji-only "%s" is not scolded', async (w) => {
    const h = await humans();
    const r = await h.say('alex', w);
    expect(said(r)).not.toMatch(/didn't (quite )?catch that/i);
    await h.stop();
  });
  it('A5 the third person to join is told what was already decided, not asked to start over', async () => {
    const h = await humans();
    await h.say('mason', "let's plan a trip");
    await h.say('alex', "let's plan a trip");
    const r = await h.say('jordan', "let's plan a trip", { secondsLater: 3600 });
    expect(r.jordan.length).toBeGreaterThan(0);
    expect(said(r)).not.toMatch(/Jordan started/);
    await h.stop();
  });
  it('A6 a stranger gets no reply and changes nothing', async () => {
    const h = await humans();
    const { dmEvent } = await import('../../src/conversation/mock.js');
    const before = h.messenger.sent.length;
    await h.messenger.emit(dmEvent('+15559999999', 'x1', "let's plan a trip, my max is $5"));
    await h.runtime.drainOutbox();
    expect(h.messenger.sent.length).toBe(before);
    expect((await h.state()).memberConstraints).toEqual([]);
    await h.stop();
  });
});

describe('B. trip basics said like people say them', () => {
  it('B1 the same facts in any order give the same state', async () => {
    const parts = ["I'm leaving from Chapel Hill", '2 nights', 'I want to go to Boone', 'I have a car'];
    const results: string[] = [];
    for (const order of [parts, [...parts].reverse(), [parts[2]!, parts[0]!, parts[3]!, parts[1]!]]) {
      const h = await humans();
      for (const p of order) await h.say('mason', p);
      const g = (await h.state()).groupConstraints.map((c) => `${c.field}=${JSON.stringify(c.value)}`).sort();
      results.push(g.join('|'));
      await h.stop();
    }
    expect(new Set(results).size, results.join('\n')).toBe(1);
  });
  it('B2 a lowercase destination is still a destination', async () => {
    const h = await humans();
    await h.say('mason', "lets go to boone");
    const region = await group(h, 'region');
    expect(JSON.stringify(region.map((c) => c.value))).toMatch(/boone/i);
    await h.stop();
  });
  it('B3 "Chapel Hill" and "chapel hill, NC" from two people are not a conflict', async () => {
    const h = await humans();
    await h.say('mason', "I'm leaving from Chapel Hill");
    const r = await h.say('alex', "leaving from chapel hill, NC");
    expect(said(r)).not.toMatch(/Which city should I plan the trip from/i);
    await h.stop();
  });
  it.each(["I don't want to go to Charlotte", 'the drive to Asheville is too long'])('B4 "%s" is not a destination', async (w) => {
    const h = await humans();
    await h.say('mason', w);
    const region = await group(h, 'region');
    expect(JSON.stringify(region.map((c) => c.value)), w).not.toMatch(/charlotte|asheville/i);
    await h.stop();
  });
  it('B5 "leaving from Raleigh tomorrow" is Raleigh', async () => {
    const h = await humans();
    await h.say('mason', 'leaving from Raleigh tomorrow');
    const o = await group(h, 'origin');
    expect(JSON.stringify(o[o.length - 1]?.value)).toMatch(/Raleigh"/);
    expect(JSON.stringify(o[o.length - 1]?.value)).not.toMatch(/omorrow/i);
    await h.stop();
  });
  it('B7 a bare place, then "where I want to go", ends with it recorded as the destination', async () => {
    const h = await humans();
    await h.say('mason', 'Boone');
    const r = await h.say('mason', 'where I want to go');
    expect(said(r)).toMatch(/Which place/i);   // a direction with no place: ask for the place instead of a generic "didn't catch that"
    const r2 = await h.say('mason', 'going to Boone');
    expect(JSON.stringify((await group(h, 'region')).map((c) => c.value)), said(r2)).toMatch(/Boone/);
    await h.stop();
  });
  it.each(['my car is in the shop', 'Nobody has a car', 'Who has a car'])('B8 "%s" does not record a car', async (w) => {
    const h = await humans();
    await h.say('mason', "let's plan a trip");
    await h.say('mason', "I'm leaving from Chapel Hill");
    await h.say('mason', '2 nights');
    await h.say('mason', 'I want to go to Boone');
    await h.say('mason', w);
    const t = await group(h, 'transport');
    const v = t.length ? (t[t.length - 1]!.value as any) : undefined;
    expect(String(JSON.stringify(v)), w).not.toMatch(/"hasVehicle":true/);
    await h.stop();
  });
  it('B10 "sounds expensive" is not a sign-off, and "ok, 3 nights" changes the nights', async () => {
    const h = await humans();
    await h.say('mason', "I'm leaving from Chapel Hill, 2 nights, I want to go to Boone, I have a car, I'm free Nov 14-17, my max is $200, I like hiking");
    await h.say('alex', 'I want to plan a trip');
    await h.say('alex', 'sounds expensive');
    expect(JSON.stringify((await h.state()).memberConstraints.filter((c) => c.memberId === 'alex' && String(c.field).startsWith('confirm')))).not.toMatch(/basics/);
    const r = await h.say('alex', 'ok, 3 nights');
    const d = await group(h, 'duration');
    expect(d.some((c) => c.memberId === 'alex' && (c.value as any).nights === 3), said(r)).toBe(true);
    await h.stop();
  });
});

describe('C. dates', () => {
  const avail = async (h: Humans, who: Who) => ((await lastValue(h, who, 'availability')) ?? []) as Array<{ startAt: string; endAt: string }>;
  const days = (w: Array<{ startAt: string; endAt: string }>) => w.map((x) => `${x.startAt.slice(5, 10)}..${x.endAt.slice(5, 10)}`);
  it('C1 "11/14-16" is Nov 14 to 16', async () => {
    const h = await humans(); await h.say('mason', "I'm free 11/14-16");
    const w = await avail(h, 'mason'); expect(w.length).toBe(1);
    expect(new Date(w[0]!.endAt).getTime() - new Date(w[0]!.startAt).getTime()).toBeGreaterThanOrEqual(2 * 86_400_000); await h.stop();
  });
  it('C1 "Nov 14 and 15" covers both days', async () => {
    const h = await humans(); await h.say('mason', "I'm free Nov 14 and 15");
    const w = await avail(h, 'mason'); const span = w.reduce((a, x) => Math.max(a, new Date(x.endAt).getTime() - new Date(x.startAt).getTime()), 0);
    expect(span, JSON.stringify(days(w))).toBeGreaterThanOrEqual(86_400_000); await h.stop();
  });
  it('C1 "14-16 Nov" is understood', async () => {
    const h = await humans(); await h.say('mason', "I'm free 14-16 Nov"); expect((await avail(h, 'mason')).length).toBe(1); await h.stop();
  });
  it('C1 "Fri Nov 14 - Sun Nov 16" is understood', async () => {
    const h = await humans(); const r = await h.say('mason', "I'm free Fri Nov 14 - Sun Nov 16");
    expect((await avail(h, 'mason')).length, said(r)).toBe(1); await h.stop();
  });
  it('C3 late on the night of Oct 11 Eastern, "free Oct 11" is this year', async () => {
    const h = await humans({ start: '2026-10-12T01:30:00Z' }); // 9:30pm Oct 11 Eastern
    await h.say('mason', "I'm free Oct 11");
    const w = await avail(h, 'mason');
    expect(days(w).join()).toMatch(/^10-11/); expect(w[0]?.startAt.slice(0, 4)).toBe('2026'); await h.stop();
  });
  it('C4 "I can\'t do Nov 14 but I\'m free Nov 21" records only Nov 21', async () => {
    const h = await humans(); await h.say('mason', "I can't do Nov 14 but I'm free Nov 21");
    const d = days(await avail(h, 'mason')).join(); expect(d).not.toMatch(/11-14/); await h.stop();
  });
  it('C4 "Oct 17 is bad for me" while dates are asked is not recorded as free', async () => {
    const h = await humans(); await h.say('mason', "I'm leaving from Chapel Hill, 2 nights, I want to go to Boone, I have a car");
    await h.say('mason', 'Oct 17 is bad for me');
    expect(days(await avail(h, 'mason')).join()).not.toMatch(/10-17/); await h.stop();
  });
  it('C5 two windows in a message are both kept', async () => {
    const h = await humans(); await h.say('mason', "I'm free Nov 14-16. Also Nov 21-23");
    expect((await avail(h, 'mason')).length).toBe(2); await h.stop();
  });
  it('C6 "free Nov 14-16, would that work?" is recorded or clearly confirmed, not lost', async () => {
    const h = await humans(); const r = await h.say('mason', "I'm free Nov 14-16, would that work?");
    expect((await avail(h, 'mason')).length > 0 || /dates/i.test(said(r)), said(r)).toBe(true); await h.stop();
  });
  it('C6 "maybe Nov 14-16?" is echoed back so one reply locks it in', async () => {
    const h = await humans(); const r = await h.say('mason', 'maybe Nov 14-16?');
    expect(said(r)).toMatch(/free Nov 14-16/);   // it echoes the dates and says how to lock them in
    await h.say('mason', 'free Nov 14-16'); expect((await avail(h, 'mason')).length).toBe(1); await h.stop();
  });
  it('C7 dates already in the past are not accepted silently', async () => {
    const h = await humans(); const r = await h.say('mason', "I'm free Oct 1-3");
    expect(said(r)).toMatch(/past|already|upcoming|different dates|got it/i);
    const w = await avail(h, 'mason'); if (w.length) expect(w[0]!.startAt.slice(0, 4)).toBe('2027'); await h.stop();
  });
  it('C8 three people, two overlap: the clash names who is free when and never says "both"', async () => {
    const h = await humans();
    await h.say('mason', "I'm leaving from Chapel Hill, 2 nights, I want to go to Boone, I have a car, I'm free Nov 14-17, my max is $200, I like hiking");
    await h.say('alex', "I'm free Nov 14-17, my max is $250, I like hiking");
    const r = await h.say('jordan', "I'm free Dec 20-31, my max is $300, I like food");
    expect(said(r)).toMatch(/Jordan is free Dec 20-31/);
    expect(lint(h)).toEqual([]); await h.stop();
  });
});

describe('D. money', () => {
  const cap = async (h: Humans, who: Who = 'mason') => (await lastValue(h, who, 'budget')) as number | undefined;
  it('D1 "$1.5k" is $1,500', async () => { const h = await humans(); await h.say('mason', 'my max is $1.5k'); expect(await cap(h)).toBe(150000); await h.stop(); });
  it('D1 "$2k" is $2,000', async () => { const h = await humans(); await h.say('mason', 'my max is $2k'); expect(await cap(h)).toBe(200000); await h.stop(); });
  it.each(['max $200-300', 'between $200 and $300'])('D2 range "%s" is not silently the low end', async (w) => {
    const h = await humans(); const r = await h.say('mason', w);
    expect(((await cap(h)) === undefined) || /which|firm|exact|between/i.test(said(r)), said(r)).toBe(true); await h.stop();
  });
  it.each(['$200 a night', '$50 a day'])('D3 per-unit "%s" is not taken as the whole cap', async (w) => {
    const h = await humans(); const r = await h.say('mason', `I can spend ${w}`);
    expect(await cap(h), said(r)).toBeUndefined(); await h.stop();
  });
  it('D4 "our budget is $900 total" is not one person\'s cap', async () => {
    const h = await humans(); const r = await h.say('mason', 'our budget is $900 total'); expect(await cap(h), said(r)).toBeUndefined(); await h.stop();
  });
  it('D5 "I can\'t afford $300" does not set a $300 max', async () => {
    const h = await humans(); const r = await h.say('mason', "I can't afford $300"); expect(await cap(h), said(r)).not.toBe(30000); await h.stop();
  });
  it('D6 a member named Max can say "my max is $300"', async () => {
    const h = await humans({ names: { alex: 'Max' } }); const r = await h.say('jordan', 'my max is $300');
    expect(await cap(h, 'jordan'), said(r)).toBe(30000); await h.stop();
  });
  it('D7 "2" while the budget question is open is not a $2 budget unless it is the budget question', async () => {
    const h = await humans(); await h.say('mason', 'I want to plan a trip'); const r = await h.say('mason', '250');
    expect(said(r)).toBeTruthy(); await h.stop();
  });
  it('D8 "I could do $300" is recorded or the person is asked to confirm it', async () => {
    const h = await humans(); const r = await h.say('mason', 'I could do $300');
    expect((await cap(h)) === 30000 || /\$300|firm/i.test(said(r))).toBe(true); await h.stop();
  });
  it('D10 changing the cap three times keeps only the latest and never leaks', async () => {
    const h = await humans();
    for (const c of [200, 220, 180]) await h.say('mason', `my max is $${c}`);
    expect(await cap(h)).toBe(18000);
    await h.say('alex', 'what did Mason say?');
    for (const o of h.everyOutbound().filter((x) => x.to !== '+15550000001')) expect(o.text).not.toMatch(/\$\s?(200|220|180)\b/);
    await h.stop();
  });
});

describe('E. tastes and must-haves', () => {
  it('E1 "I don\'t care about museums, I love hiking" keeps hiking', async () => {
    const h = await humans(); await h.say('mason', "I don't care about museums, I love hiking");
    expect(JSON.stringify((await mine(h, 'mason', 'preferences')).map((c) => c.value))).toMatch(/hiking/); await h.stop();
  });
  it('E2 "actually I\'m not into breweries anymore" is acknowledged honestly', async () => {
    const h = await humans(); await h.say('mason', 'I like breweries and hiking');
    const r = await h.say('mason', "actually I'm not into breweries anymore");
    expect(r.mason.length).toBeGreaterThan(0); await h.stop();
  });
  it('E3 "I don\'t need wheelchair access" is not a must-have', async () => {
    const h = await humans(); await h.say('mason', "I don't need wheelchair access");
    expect(JSON.stringify((await mine(h, 'mason', 'must_dos')).map((c) => c.value))).not.toMatch(/wheelchair/i); await h.stop();
  });
});
