import { describe, expect, it } from 'vitest';
import { planTrip } from '../../src/planning/generate.js';
import { createGeminiProvider } from '../../src/research/gemini.js';
import { createResearchProvider } from '../../src/research/provider.js';
import { ids, put, readyState, NOW } from './fixtures.js';

// The phone test that failed: two people, a $1,000,000 max each, Washington DC, "historical monuments" and "food".
// Search came back with roads, prices could not be found, and the bot said no trip worked.

function answer(lines: string[]) {
  const text = lines.join('\n');
  const annotations = [];
  let end = 0;
  for (let i = 0; i < lines.length; i += 1) {
    end += lines[i].length + (i > 0 ? 1 : 0);
    annotations.push({ type: 'url_citation', url: `https://r.example/${i}`, title: 'nps.gov', start_index: 0, end_index: end });
  }
  return { steps: [{ type: 'model_output', content: [{ type: 'text', text, annotations }] }] };
}
const line = (name: string, region: string, stops: string, drive = '240') => `OPTION | ${name} | ${region} | ${drive} | history, food | unknown | unknown | unknown | unknown | ${stops} | A tradeoff.`;
const ROADS = [
  line('US-29 Piedmont Route', 'Virginia', 'Drive US-29~Virginia~3~'),
  line('US-15 Historic Byway', 'Virginia', 'Drive US-15~Virginia~3~'),
  line('I-81 Detour', 'Virginia', 'Drive I-81~Virginia~3~'),
  line('Bypass Route via US-301', 'Maryland', 'Drive US-301~Maryland~3~'),
];
const PLACES = [
  line('A weekend of monuments', 'Washington, DC', 'National Mall~Washington, DC~3~monuments;Smithsonian museums~Washington, DC~3~museums'),
  line('A weekend of food and history', 'Washington, DC', 'Eastern Market~Washington, DC~2~food;Union Station~Washington, DC~1~history'),
];

function dcState() {
  let state = readyState({ mason: 100_000_000, alex: 100_000_000, jordan: 100_000_000 });
  for (const id of ids) {
    state = put(state, id, 'region', { destination: 'Washington DC' });
    state = put(state, id, 'preferences', { items: ['historical monuments', 'food'] });
  }
  return state;
}
const provider = (respond: (prompt: string) => Response | Promise<Response>) =>
  createResearchProvider({
    mode: 'live',
    live: createGeminiProvider({ apiKey: 'k', now: () => NOW, fetch: (async (_u: string, init: RequestInit) => respond(JSON.parse(init.body as string).input as string)) as never }),
  });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('with a $1,000,000 max everyone gets two options', () => {
  it('when every price lookup finds nothing', async () => {
    const outcome = await planTrip(dcState(), provider((p) => json(p.includes('OPTION |') ? answer([...ROADS, ...PLACES]) : answer(['nothing']))));
    const feasible = outcome.candidates.filter((c) => c.feasibility.feasible);
    expect(feasible).toHaveLength(2);
    expect(feasible.map((c) => c.title).sort()).toEqual(['A weekend of food and history', 'A weekend of monuments']);
    expect(outcome.replies.map((r) => r.text).join('\n')).not.toMatch(/US-\d|I-81|couldn't find a trip/);
  });

  it('when every price lookup fails outright', async () => {
    const outcome = await planTrip(dcState(), provider((p) => (p.includes('OPTION |') ? json(answer(PLACES)) : new Response('quota', { status: 429 }))));
    expect(outcome.candidates.filter((c) => c.feasibility.feasible)).toHaveLength(2);
  });

  it('when the first search is mostly roads and a second search has to fill the gap', async () => {
    const results = [answer([...ROADS, PLACES[0]]), answer([PLACES[1]])];
    const outcome = await planTrip(dcState(), provider((p) => json(p.includes('OPTION |') ? results.shift() ?? answer([]) : answer(['nothing']))));
    expect(outcome.candidates.filter((c) => c.feasibility.feasible)).toHaveLength(2);
  });

  it('when the drive time is not given for any option', async () => {
    const noDrive = PLACES.map((l) => l.replace('| 240 |', '| unknown |'));
    const outcome = await planTrip(dcState(), provider((p) => json(p.includes('OPTION |') ? answer(noDrive) : answer(['nothing']))));
    expect(outcome.candidates.filter((c) => c.feasibility.feasible)).toHaveLength(2);
    expect(outcome.replies.map((r) => r.text).join('\n')).toMatch(/About \$\d+ each, up to \$\d+ at the high end \(hotel \$\d+/);
  });

  it('and still labels the costs as typical, not found', async () => {
    const outcome = await planTrip(dcState(), provider((p) => json(p.includes('OPTION |') ? answer(PLACES) : answer(['nothing']))));
    expect(outcome.replies.map((r) => r.text).join('\n')).toMatch(/typical cost/);
  });
});
