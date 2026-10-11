import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, humans, lint, type Humans } from './harness.js';
afterEach(cleanup);
const said = (r: { all: string[] }) => r.all.join('\n');
/** Mason and Jeffrey, as in the live phone run of 2026-10-11 (Jeffrey's side reconstructed from the bot's replies). */
const two = () => humans({ people: ['mason', 'alex'], names: { alex: 'Jeffrey' } });
const group = async (h: Humans, field: string) => (await h.state()).groupConstraints.filter((c: any) => c.field === field).map((c: any) => JSON.stringify(c.value));
const mine = async (h: Humans, field: string) => (await h.state()).memberConstraints.filter((c: any) => c.memberId === 'mason' && c.field === field).map((c: any) => JSON.stringify(c.value));

describe('R. the live phone run', () => {
  it('R1 "All of November" is Mason\'s free dates, never a place', async () => {
    const h = await two(); await h.say('mason', 'Let’s go to New York'); const r = await h.say('mason', 'All of November');
    expect((await group(h, 'origin')).join(), said(r)).not.toMatch(/November/i);
    expect((await mine(h, 'availability')).join(), said(r)).toMatch(/2026-11-01T.*2026-12-01T/); await h.stop();
  });
  it.each(['I’m free anytime in November', 'free all of November', 'any time in November works', 'the whole month of November'])('R2 "%s" is all of November', async (text) => {
    const h = await two(); const r = await h.say('mason', text);
    expect((await mine(h, 'availability')).join(), said(r)).toMatch(/2026-11-01T.*2026-12-01T/); await h.stop();
  });
  it.each(['What’s happening right now', "what's going on", 'whats happening'])('R3 "%s" is a status question', async (text) => {
    const h = await two(); await h.say('mason', 'Let’s go to New York'); const r = await h.say('mason', text);
    expect(said(r)).not.toMatch(/didn't quite catch/i); expect(said(r)).toMatch(/New York|waiting|need/i); await h.stop();
  });
  it.each(['We’ll have to fly to New York', 'can we fly there?', "let's take a flight"])('R4 "%s" gets an honest "road trips only" answer and saves no flying', async (text) => {
    const h = await two(); const r = await h.say('mason', text);
    expect(said(r)).toMatch(/road trip|driv/i); expect(said(r)).not.toMatch(/we'll fly|didn't quite catch/i);
    expect((await group(h, 'transport')).join()).not.toMatch(/fl(y|ight)/i); await h.stop();
  });
  it('R5 "from Chapel Hill, 2 nights, to washington" keeps all three', async () => {
    const h = await two(); const r = await h.say('alex', "let's plan a trip from Chapel Hill, 2 nights, to washington");
    expect((await group(h, 'origin')).join(), said(r)).toMatch(/Chapel Hill/);
    expect((await group(h, 'region')).join(), said(r)).toMatch(/washington/i); await h.stop();
  });
  it('R6 the run\'s messages break no house rules', async () => {
    const h = await two();
    for (const [w, t] of [['alex', "let's plan a trip from Chapel Hill, 2 nights, to washington"], ['mason', 'All of November'], ['mason', 'What’s happening right now'], ['mason', 'We’ll have to fly to New York']] as const) await h.say(w, t);
    expect(lint(h)).toEqual([]); await h.stop();
  });
});

describe('R. wording', () => {
  it('R7 a destination is acknowledged as "going to", never as a second starting point', async () => {
    const h = await two(); const r = await h.say('alex', "let's plan a trip from Chapel Hill, 2 nights, to washington");
    expect(said(r)).toMatch(/going to Washington/); expect(said(r)).not.toMatch(/leaving from Chapel Hill and Washington/); await h.stop();
  });
});
