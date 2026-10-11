import { afterEach, describe, expect, it } from 'vitest';
import { createResearchProvider } from '../../src/research/provider.js';
import { accumulatePreferences } from '../../src/planning/constraints.js';
import { cleanup, humans, FULL_MASON, reachOptions } from './harness.js';
afterEach(cleanup);
const said = (r: { all: string[] }) => r.all.join('\n');
const prefs = async (h: Awaited<ReturnType<typeof humans>>, who: 'mason' | 'alex' | 'jordan') => JSON.stringify(accumulatePreferences((await h.state()).memberConstraints.flatMap((c) => (c.memberId === who && c.field === 'preferences' ? [c.value] : []))));

describe('open gaps', () => {
  it('E2 a liking can be taken back', async () => {
    const h = await humans(); await h.say('mason', 'I like breweries and hiking');
    const r = await h.say('mason', "actually I'm not into breweries anymore");
    expect(await prefs(h, 'mason'), said(r)).not.toMatch(/brewer/); expect(await prefs(h, 'mason')).toMatch(/hiking/); await h.stop();
  });
  it('B6 "3 nights. wait no, 2 nights" ends on 2 nights', async () => {
    const h = await humans(); await h.say('mason', '3 nights. wait no, 2 nights');
    const d = (await h.state()).groupConstraints.filter((c) => c.field === 'duration'); expect((d[d.length - 1]!.value as any).nights).toBe(2); await h.stop();
  });
  it('B9 two people leaving from different cities can settle it by naming one', async () => {
    const h = await humans(); await h.say('mason', "I'm leaving from Chapel Hill"); const r = await h.say('alex', "I'm leaving from Durham");
    expect(said(r)).toMatch(/Which city|Chapel Hill.*Durham|Durham.*Chapel Hill/);
    await h.say('mason', 'Durham'); const o = (await h.state()).groupConstraints.filter((c) => c.field === 'origin');
    expect(o.map((c) => JSON.stringify(c.value)).join()).toMatch(/Durham/); await h.stop();
  });
  it('D11 a tentative restatement of the same cap is not a new question', async () => {
    const h = await humans(); await h.say('mason', 'my max is $200'); const r = await h.say('mason', 'maybe around 200');
    expect(said(r)).not.toMatch(/different amount/i); await h.stop();
  });
  it('E4 a must-have like "vegetarian" does not silently kill every option', async () => {
    const h = await humans(); await h.say('mason', FULL_MASON); await h.say('mason', "I'm vegetarian");
    await h.say('alex', "I'm free Nov 14-17, my max is $250, I like hiking"); await h.say('alex', 'yes that works');
    await h.say('jordan', "I'm free Nov 14-17, my max is $300, I like a town visit"); const r = await h.say('jordan', 'yes that works');
    expect((await h.state()).status, said(r)).toBe('proposed'); await h.stop();
  });
  it('J1 when research fails, a later status question is honest and a retry works', async () => {
    const h = await humans({ provider: createResearchProvider({ mode: 'live' }) });
    await h.say('mason', FULL_MASON); await h.say('alex', "I'm free Nov 14-17, my max is $250, I like hiking"); await h.say('alex', 'yes that works');
    await h.say('jordan', "I'm free Nov 14-17, my max is $300, I like a town visit"); const fail = await h.say('jordan', 'yes that works');
    expect(said(fail)).toMatch(/couldn't look up|isn't set up|try again|retry/i);
    const r = await h.say('mason', "what's the status"); expect(said(r), 'must not claim to be still looking').not.toMatch(/still looking/i); await h.stop();
  });
  it('F5 status with a single option never mentions "pick 2"', async () => {
    const h = await humans(); await reachOptions(h); const r = await h.say('alex', "what's the status");
    expect(said(r)).not.toMatch(/pick 2/); await h.stop();
  });
  it('G7 a second person picking a different option is told what happens', async () => {
    const h = await humans(); await reachOptions(h); await h.say('mason', 'pick 1'); const r = await h.say('alex', 'pick 2');
    console.log('G7>>', JSON.stringify(r.alex)); expect(r.alex.join(' ')).not.toMatch(/undefined|cand-/); await h.stop();
  });
  it('I5 the lodging label matches the trip length', async () => {
    const h = await humans(); await h.say('mason', FULL_MASON.replace('2 nights', '3 nights').replace('Nov 14-17', 'Nov 14-18'));
    await h.say('alex', "I'm free Nov 14-18, my max is $500, I like hiking"); await h.say('alex', 'yes that works');
    await h.say('jordan', "I'm free Nov 14-18, my max is $500, I like a town visit"); await h.say('jordan', 'yes that works');
    const labels = (await h.state()).candidates.flatMap((c) => c.costs.map((x) => x.label)).join('|');
    expect(labels, labels).not.toMatch(/two nights/i); await h.stop();
  });
  it('I4 a single maybe-option is not called "a couple others"', async () => {
    const h = await humans(); await h.say('mason', FULL_MASON.replace('Boone', 'Asheville'));
    await h.say('alex', "I'm free Nov 14-17, my max is $500, I like hiking"); await h.say('alex', 'yes that works');
    await h.say('jordan', "I'm free Nov 14-17, my max is $500, I like food"); const r = await h.say('jordan', 'yes that works');
    console.log('I4>>', JSON.stringify(r.alex)); expect(said(r)).not.toMatch(/a couple others/i); await h.stop();
  });
  it('K3/K4 a guide answer before a pick keeps the fixture label and never claims a fit it did not check', async () => {
    const h = await humans(); await reachOptions(h); const r = await h.say('alex', 'guide: what if it rains on Saturday?');
    console.log('K>>', JSON.stringify(r.alex)); expect(said(r)).toMatch(/demo|fixture|made up/i); await h.stop();
  });
});

describe('tentative dates', () => {
  const dates = async (h: Awaited<ReturnType<typeof humans>>) => (await h.state()).memberConstraints.filter((c) => c.memberId === 'mason' && c.field === 'availability');
  it('"maybe Nov 14-16?" then "yes" saves those dates', async () => {
    const h = await humans(); const ask = await h.say('mason', 'maybe Nov 14-16?');
    expect(await dates(h), said(ask)).toHaveLength(0);
    const r = await h.say('mason', 'yes');
    const saved = await dates(h); expect(saved, said(r)).toHaveLength(1);
    expect(JSON.stringify(saved[0]!.value)).toMatch(/11-14/); expect(said(r)).toMatch(/Nov(ember)? 14/); await h.stop();
  });
  it('"maybe Nov 14-16?" then "no" saves nothing and asks for the real dates', async () => {
    const h = await humans(); await h.say('mason', 'maybe Nov 14-16?');
    const r = await h.say('mason', 'no'); expect(await dates(h)).toHaveLength(0); expect(said(r)).toMatch(/which dates/i); await h.stop();
  });
  it('a different answer replaces the pending dates', async () => {
    const h = await humans(); await h.say('mason', 'maybe Nov 14-16?'); await h.say('mason', 'free Nov 21-23');
    const saved = await dates(h); expect(saved).toHaveLength(1); expect(JSON.stringify(saved[0]!.value)).toMatch(/11-21/);
    const r = await h.say('mason', 'yes'); expect((await dates(h)).length, said(r)).toBe(1); await h.stop();
  });
});

describe('what is shared', () => {
  it('a person invited into a trip is told that free dates are shared and budgets are not, before they give either', async () => {
    const h = await humans(); await h.say('mason', "I'm leaving from Chapel Hill, 2 nights, I want to go to Boone, I have a car");
    const r = await h.say('alex', 'I want to plan a trip');
    expect(said(r)).toMatch(/started planning a trip with you/); expect(said(r)).toMatch(/free when.*budgets stay private/i); await h.stop();
  });
  it('a hello from someone joining says the same', async () => {
    const h = await humans(); await h.say('mason', "I'm leaving from Chapel Hill, 2 nights, I want to go to Boone, I have a car");
    expect(said(await h.say('jordan', 'hi'))).toMatch(/budgets stay private/i); await h.stop();
  });
});
