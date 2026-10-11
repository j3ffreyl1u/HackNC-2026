import { describe, expect, it, vi } from 'vitest';
import { buildPrompt, createGeminiProvider, parseInteraction } from '../../src/research/gemini.js';
import { EvidenceStore } from '../../src/research/grounding.js';
import { looksLikeRoute, priceOption } from '../../src/research/pricing.js';
import type { ResearchOption, ResearchRequest } from '../../src/research/types.js';

const NOW = '2026-10-10T12:00:00.000Z';

function answer(lines: string[], cited: number = lines.length, sources = ['nps.gov']) {
  const text = lines.join('\n');
  const annotations = [];
  let end = 0;
  for (let i = 0; i < Math.min(cited, lines.length); i += 1) {
    end += lines[i].length + (i > 0 ? 1 : 0);
    for (const title of sources) annotations.push({ type: 'url_citation', url: `https://r.example/${title}/${i}`, title, start_index: 0, end_index: end });
  }
  return { steps: [{ type: 'model_output', content: [{ type: 'text', text, annotations }] }] };
}
const opt = (name: string, region = 'Washington, DC', stops = 'National Mall~Washington, DC~3~monuments') =>
  `OPTION | ${name} | ${region} | 240 | history, food | unknown | unknown | unknown | unknown | ${stops} | A tradeoff.`;
const dc: ResearchRequest = { purpose: 'plan', revision: 1, origin: 'Chapel Hill', destination: 'Washington DC', interests: ['historical monuments', 'food'], nights: 2, groupSize: 2 };

describe('searching for places, not routes', () => {
  it('asks for places and things to do in the destination that match the interests, and says routes are not options', () => {
    const prompt = buildPrompt(dc);
    expect(prompt).toMatch(/places to visit|things to do/i);
    expect(prompt).toMatch(/never a road, a route/i);
    expect(prompt).toContain('historical monuments, food');
    expect(prompt).toContain('Washington DC');
  });

  it('recognises road and route names', () => {
    for (const name of ['US-29 Piedmont Route', 'US-15 Historic Byway', 'I-81 Detour', 'Bypass Route via US-301', 'Detour on the Blue Ridge', 'NC-12 Highway']) {
      expect(looksLikeRoute(name), name).toBe(true);
    }
    for (const name of ['National Mall', 'Union Station', 'Eastern Market', 'Smithsonian museums', 'Highland Cabins', 'Route 66 Diner']) {
      expect(looksLikeRoute(name), name).toBe(false);
    }
  });

  it('drops an option that is a road, and the road stops inside a real option', () => {
    const lines = [
      opt('US-29 Piedmont Route', 'Virginia', 'Drive US-29~Virginia~3~'),
      opt('I-81 Detour', 'Virginia', 'Drive I-81~Virginia~3~'),
      opt('A weekend of monuments', 'Washington, DC', 'Drive on I-95~Virginia~4~;National Mall~Washington, DC~3~monuments'),
    ];
    const result = parseInteraction(answer(lines), dc, NOW);
    expect(result.options.map((o) => o.name)).toEqual(['A weekend of monuments']);
    expect(result.options[0].stops.map((s) => s.label)).toEqual(['National Mall']);
    expect(result.limitations.join(' ')).toMatch(/roads or routes/i);
  });
});

describe('an option always has a price to show', () => {
  const option: ResearchOption = {
    optionId: 'o1', name: 'A weekend in DC', region: 'Washington, DC', tags: [], stops: [{ label: 'National Mall', location: 'Washington, DC', tags: ['monuments'], hours: 3, evidenceIds: [] }],
    costs: [], perPersonCosts: [], evidenceIds: [], tradeoffs: [],
  };
  const nothing = async () => answer(['nothing here'], 0);

  it('estimates fuel from the largest drive the group allowed when the drive time is unknown', async () => {
    const { option: priced } = await priceOption(option, { ...dc, maxTravelMinutes: 300 }, nothing, new EvidenceStore(NOW), { typicalCosts: true });
    const fuel = priced.costs.find((c) => c.costId === 'fuel')!;
    expect(fuel.priceStatus).toBe('estimate');
    expect(fuel.highCents).toBeGreaterThan(0);
    expect(fuel.label).toMatch(/typical cost/i);
  });

  it('flying swaps fuel and parking for an estimated airfare per person, and never looks up fuel', async () => {
    const asked: string[] = [];
    const spy = async (prompt: string) => { asked.push(prompt); return answer(['nothing here'], 0); };
    const { option: priced } = await priceOption(option, { ...dc, travel: 'plane', maxTravelMinutes: 300 }, spy as never, new EvidenceStore(NOW), { typicalCosts: false });
    const flights = priced.costs.find((c) => c.costId === 'flights')!;
    expect(priced.costs.some((c) => c.costId === 'fuel' || c.costId === 'parking')).toBe(false);
    expect(flights.priceStatus).toBe('estimate');
    expect(flights.label).toMatch(/Round-trip flights.*typical cost, not a found price/);
    expect(flights.lowCents).toBe((dc.groupSize ?? 1) * 18_000);
    expect(flights.highCents).toBe((dc.groupSize ?? 1) * 45_000);
    expect(priced.tradeoffs.join(' ')).toMatch(/Flights are a typical round-trip fare per person/);
    expect(asked.some((p) => /FUEL \|/.test(p))).toBe(false);
  });

  it('driving still prices fuel and has no airfare', async () => {
    const { option: priced } = await priceOption(option, { ...dc, travel: 'car' }, nothing, new EvidenceStore(NOW), { typicalCosts: true });
    expect(priced.costs.some((c) => c.costId === 'fuel')).toBe(true);
    expect(priced.costs.some((c) => c.costId === 'flights')).toBe(false);
  });

  it('the search prompt asks for trips reached by flying when the group flies', () => {
    expect(buildPrompt({ ...dc, travel: 'plane' })).toMatch(/fly there/);
    expect(buildPrompt({ ...dc, travel: 'plane' })).not.toMatch(/by car/);
    expect(buildPrompt(dc)).toMatch(/drive there by car/);
  });

  it('estimates fuel from a default drive when there is neither a drive time nor a limit', async () => {
    const { option: priced } = await priceOption(option, dc, nothing, new EvidenceStore(NOW), { typicalCosts: true });
    expect(priced.costs.find((c) => c.costId === 'fuel')!.priceStatus).toBe('estimate');
  });

  it('adds a parking estimate, never zero at the top end, and lists lodging, fuel, parking, food and admissions', async () => {
    const { option: priced } = await priceOption(option, dc, nothing, new EvidenceStore(NOW), { typicalCosts: true });
    const all = [...priced.costs, ...priced.perPersonCosts];
    expect(all.map((c) => c.costId).sort()).toEqual(['admissions', 'food', 'fuel', 'lodging', 'parking']);
    expect(all.every((c) => c.priceStatus === 'estimate')).toBe(true);
    expect(all.find((c) => c.costId === 'parking')!.highCents).toBeGreaterThan(0);
  });

  it('keeps the strict behaviour (and no parking line) when typical costs are off', async () => {
    const { option: priced } = await priceOption(option, dc, nothing, new EvidenceStore(NOW));
    expect(priced.costs.map((c) => c.costId)).toEqual(['lodging', 'fuel']);
    expect(priced.costs.every((c) => c.priceStatus === 'unknown')).toBe(true);
  });

  it('keeps the site name as the source of a found price', async () => {
    const found = async (prompt: string) => (prompt.includes('LODGING |') ? answer(['LODGING | Union Hotel | 150 | 2'], 1, ['hotelsite.com']) : answer(['nothing'], 0));
    const store = new EvidenceStore(NOW);
    const { option: priced } = await priceOption(option, dc, found, store, { typicalCosts: true });
    const lodging = priced.costs.find((c) => c.costId === 'lodging')!;
    expect(lodging.evidenceIds.map((id) => store.evidence.find((e) => e.evidenceId === id)!.title)).toEqual(['hotelsite.com']);
  });
});

describe('speed: cache and a time limit', () => {
  const lines = ['A', 'B', 'C'].map((n) => opt(`Weekend ${n}`));
  function server() {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const prompt = JSON.parse(init.body as string).input as string;
      calls.push(prompt);
      const body = prompt.includes('LODGING |') ? answer(['LODGING | Inn | 100 | 2'])
        : prompt.includes('FUEL |') ? answer(['FUEL | 160 | 4.07'])
        : prompt.includes('MEAL |') ? answer(['MEAL | Diner | 20'])
        : answer(lines);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return { calls, fetchImpl };
  }

  it('answers a repeat search for the same destination without asking the service again', async () => {
    const s = server();
    const provider = createGeminiProvider({ apiKey: 'k', fetch: s.fetchImpl as never, now: () => NOW });
    const first = await provider.search(dc);
    const callsAfterFirst = s.calls.length;
    const second = await provider.search({ ...dc, revision: 2 });
    expect(s.calls.length).toBe(callsAfterFirst);
    expect(second.revision).toBe(2);
    expect(second.options.map((o) => o.name)).toEqual(first.options.map((o) => o.name));
  });

  it('does not reuse the cache for a different destination or different dates', async () => {
    const s = server();
    const provider = createGeminiProvider({ apiKey: 'k', fetch: s.fetchImpl as never, now: () => NOW });
    await provider.search(dc);
    const before = s.calls.length;
    await provider.search({ ...dc, destination: 'Boone' });
    expect(s.calls.length).toBeGreaterThan(before);
  });

  it('never caches a failure', async () => {
    let fail = true;
    const s = server();
    const flaky = vi.fn(async (url: string, init: RequestInit) => (fail ? new Response('no', { status: 500 }) : s.fetchImpl(url, init)));
    const provider = createGeminiProvider({ apiKey: 'k', fetch: flaky as never, now: () => NOW });
    await expect(provider.search(dc)).rejects.toThrow();
    fail = false;
    expect((await provider.search(dc)).options.length).toBeGreaterThan(0);
  });

  it('gives price lookups only what is left of a 45 second budget', async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const timeouts: number[] = [];
      const spy = vi.spyOn(globalThis, 'setTimeout');
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        const prompt = JSON.parse(init.body as string).input as string;
        if (!/LODGING \||FUEL \||MEAL \|/.test(prompt)) t += 30_000; // the first search is slow
        return new Response(JSON.stringify(prompt.includes('OPTION |') ? answer(lines) : answer(['x'], 0)), { status: 200 });
      });
      const provider = createGeminiProvider({ apiKey: 'k', fetch: fetchImpl as never, now: () => NOW, clock: () => t });
      const done = provider.search(dc);
      await vi.runAllTimersAsync();
      await done;
      timeouts.push(...spy.mock.calls.map((c) => Number(c[1])).filter((n) => n >= 10_000 && n <= 40_000));
      spy.mockRestore();
      expect(Math.min(...timeouts)).toBeLessThanOrEqual(15_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('two options when there is room', () => {
  it('searches once more when the first answer leaves fewer than two usable options', async () => {
    const answers = [
      answer([opt('US-29 Piedmont Route', 'Virginia', 'Drive~Virginia~3~'), opt('A weekend of monuments')]),
      answer([opt('A weekend of food', 'Washington, DC', 'Eastern Market~Washington, DC~2~food')]),
    ];
    const prompts: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const prompt = JSON.parse(init.body as string).input as string;
      prompts.push(prompt);
      return new Response(JSON.stringify(prompt.includes('OPTION |') ? answers.shift() ?? answer([]) : answer(['x'], 0)), { status: 200 });
    });
    const result = await createGeminiProvider({ apiKey: 'k', fetch: fetchImpl as never, now: () => NOW }).search(dc);
    expect(result.options.map((o) => o.name)).toEqual(['A weekend of monuments', 'A weekend of food']);
    expect(prompts.filter((p) => p.includes('OPTION |'))[1]).toMatch(/A weekend of monuments/); // told what was already found
  });
});

describe('a guide question gets a direct answer', () => {
  const ask: ResearchRequest = { purpose: 'guide', revision: 1, destination: 'Washington DC', interests: ['food'], question: 'is parking hard near the national mall?' };

  it('asks for one cited ANSWER line before any options', () => {
    const prompt = buildPrompt(ask);
    expect(prompt).toMatch(/ANSWER \|/);
    expect(prompt).toContain('is parking hard near the national mall?');
  });

  it('keeps a cited ANSWER line as the answer, with its sources', () => {
    const lines = ['ANSWER | Street parking near the Mall is limited and metered; garages near Union Station are the easier bet.', opt('Union Station garage', 'Washington, DC', 'Union Station~Washington, DC~1~parking')];
    const result = parseInteraction(answer(lines), ask, NOW);
    expect(result.answer?.text).toMatch(/Street parking near the Mall is limited/);
    expect(result.answer!.evidenceIds.length).toBeGreaterThan(0);
    for (const id of result.answer!.evidenceIds) expect(result.evidence.some((e) => e.evidenceId === id)).toBe(true);
    expect(result.options.map((o) => o.name)).toEqual(['Union Station garage']);
  });

  it('drops an ANSWER line no citation covers: that is the model’s own guess', () => {
    const lines = ['ANSWER | Parking is easy.', opt('Union Station garage', 'Washington, DC', 'Union Station~Washington, DC~1~parking')];
    const result = parseInteraction(answer(lines, 1), ask, NOW); // only the first line is cited ...
    expect(result.answer).toBeDefined();
    const second = parseInteraction({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ANSWER | Parking is easy.\n' + lines[1], annotations: [{ type: 'url_citation', url: 'https://r.example/x', title: 'nps.gov', start_index: 27, end_index: lines[1].length + 26 }] }] }] }, ask, NOW);
    expect(second.answer).toBeUndefined();
  });

  it('only guide questions get an answer; planning searches never do', () => {
    const lines = ['ANSWER | Something.', opt('A weekend of monuments')];
    expect(parseInteraction(answer(lines), dc, NOW).answer).toBeUndefined();
  });
});
