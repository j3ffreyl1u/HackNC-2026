import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, humans } from './harness.js';
afterEach(cleanup);
const said = (r: { all: string[] }) => r.all.join('\n');
const budget = async (h: Awaited<ReturnType<typeof humans>>) => (await h.state()).memberConstraints.filter((c) => c.memberId === 'mason' && c.field === 'budget');

describe('clueless first-timer', () => {
  it('a reversed range ("Nov 17-14") is not a window that lasts a year', async () => {
    const h = await humans(); await h.say('mason', "let's plan a trip"); await h.say('mason', 'from Chapel Hill');
    await h.say('mason', 'Nov 17-14');
    expect((await h.state()).memberConstraints.filter((c) => c.field === 'availability')).toHaveLength(0); await h.stop();
  });
  it.each(['undo', 'anywhere', 'nowhere', 'nc'])('"%s" answering "where from?" is not saved as a city', async (word) => {
    const h = await humans(); await h.say('mason', "let's plan a trip"); const r = await h.say('mason', word);
    expect((await h.state()).groupConstraints.filter((c) => c.field === 'origin'), said(r)).toHaveLength(0);
    expect(said(r)).toMatch(/leaving from/i); await h.stop();
  });
  it.each(['i have like 150 bucks', 'about 150', '150ish', '$1.5k'])('"%s" answers the budget question', async (text) => {
    const h = await humans(); for (const t of ["let's plan a trip", 'from Chapel Hill', 'Nov 14-17']) await h.say('mason', t);
    const r = await h.say('mason', text);
    expect(said(r), 'must not fall into the generic help').not.toMatch(/didn't quite catch/); await h.stop();
  });
  it('a hedged amount ("about 150") is confirmed, not locked in', async () => {
    const h = await humans(); for (const t of ["let's plan a trip", 'from Chapel Hill', 'Nov 14-17']) await h.say('mason', t);
    const r = await h.say('mason', 'about 150'); expect(said(r)).toMatch(/firm max/); expect(await budget(h)).toHaveLength(0);
    await h.say('mason', 'yes'); expect((await budget(h))[0]?.value).toBe(15000); await h.stop();
  });
  it('an unreadable answer puts the open question back', async () => {
    const h = await humans(); for (const t of ["let's plan a trip", 'from Chapel Hill', 'Nov 14-17']) await h.say('mason', t);
    const r = await h.say('mason', 'no limit'); expect(said(r)).toMatch(/maximum total/); await h.stop();
  });
  it.each(['what can you do', "what's next", 'what now'])('"%s" gets an answer, not an apology', async (text) => {
    const h = await humans(); const r = await h.say('mason', text);
    expect(said(r)).not.toMatch(/didn't quite catch/); await h.stop();
  });
});

describe('clueless first-timer, round two', () => {
  it('a bare "yes" while a question is still open puts the question back', async () => {
    const h = await humans(); await h.say('mason', "let's plan a trip");
    const r = await h.say('mason', 'yes'); expect(said(r)).toMatch(/leaving from/i); expect(said(r)).not.toMatch(/Anything else to add/); await h.stop();
  });
  it('dates that already passed this year say they mean next year', async () => {
    const h = await humans(); await h.say('mason', "let's plan a trip"); await h.say('mason', 'from Chapel Hill'); await h.say('mason', '2 nights');
    const r = await h.say('mason', 'free Oct 1-3'); expect(said(r)).toMatch(/2027/); await h.stop();
  });
  it('"this weekend" is dates, and on a Sunday it means the coming one', async () => {
    const h = await humans(); await h.say('mason', "let's plan a trip");
    const r = await h.say('mason', 'this weekend'); expect(said(r)).toMatch(/free Oct 16-18/); await h.stop();
  });
  it.each([['a couple hundred', /\$200/], ['200-250', /\$200/], ['2 hundred', /\$200/]])('"%s" is read as a budget', async (text, shown) => {
    const h = await humans(); for (const t of ["let's plan a trip", 'from Chapel Hill', 'Nov 14-17']) await h.say('mason', t);
    const r = await h.say('mason', text); expect(said(r)).toMatch(shown); await h.stop();
  });
  it('picking a number that does not exist says how many options there are', async () => {
    const { reachOptions } = await import('./harness.js');
    const h = await humans(); await reachOptions(h); const r = await h.say('alex', 'pick 5');
    expect(said(r)).toMatch(/only 1 option/); expect(said(r)).not.toMatch(/Nothing's waiting/); await h.stop();
  });
  it('"pick 1" before any options says there is nothing to pick, not "nothing is waiting"', async () => {
    const h = await humans(); const r = await h.say('alex', 'pick 1'); expect(said(r)).toMatch(/nothing to pick yet/i); await h.stop();
  });
  it('"link" gets the real trip page once there are options, and a plain answer before', async () => {
    const { reachOptions } = await import('./harness.js');
    const h = await humans(); expect(said(await h.say('alex', 'link'))).toMatch(/isn't a plan page yet/);
    await reachOptions(h); const r = await h.say('alex', 'send me the link'); expect(said(r)).not.toMatch(/\{\{/); expect(said(r)).toMatch(/trip page|http/); await h.stop();
  });
  it('the calendar is offered only once the plan is approved, with no raw token', async () => {
    const h = await humans(); const early = await h.say('alex', 'send me the calendar'); expect(said(early)).toMatch(/once everyone has agreed/); await h.stop();
  });
});

describe('approved trip', () => {
  it('asking for the calendar never sends an empty or raw-token message', async () => {
    const { reachOptions } = await import('./harness.js');
    const h = await humans(); await reachOptions(h);
    for (const w of ['mason', 'alex', 'jordan'] as const) { await h.say(w, 'ok'); }
    for (const w of ['mason', 'alex', 'jordan'] as const) { await h.say(w, "I'm in"); }
    expect((await h.state()).status).toBe('approved');
    const r = await h.say('alex', 'send me the calendar'); expect(said(r).length).toBeGreaterThan(10); expect(said(r)).not.toMatch(/\{\{/); await h.stop();
  });
});
