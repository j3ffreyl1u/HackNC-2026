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
