import { describe, expect, it, vi } from 'vitest';
import { buildPrompt, createGeminiProvider } from '../../src/research/gemini.js';
import { EvidenceStore } from '../../src/research/grounding.js';
import { priceAdmissions, priceFuel, priceLodging, priceMeals, priceOption, toCents } from '../../src/research/pricing.js';
import { createResearchProvider } from '../../src/research/provider.js';
import type { ResearchOption, ResearchRequest } from '../../src/research/types.js';

const NOW = '2026-10-10T12:00:00.000Z';

/**
 * A grounded answer shaped like the real ones: each source's citation covers the text from the start of the
 * answer through the lines it supports, so later lines are covered by more citations than earlier ones.
 */
function answer(lines: string[], cited: number = lines.length, sources = ['example.com', 'other.org']) {
  const text = lines.join('\n');
  const annotations = [];
  let end = 0;
  for (let i = 0; i < Math.min(cited, lines.length); i += 1) {
    end += lines[i].length + (i > 0 ? 1 : 0);
    for (const title of sources) annotations.push({ type: 'url_citation', url: `https://r.example/${title}/${i}`, title, start_index: 0, end_index: end });
  }
  return { steps: [{ type: 'model_output', content: [{ type: 'text', text, annotations }] }] };
}
const store = () => new EvidenceStore(NOW);

describe('toCents', () => {
  it('reads dollar amounts as exact cents and rejects everything else', () => {
    expect(toCents('167')).toBe(16_700);
    expect(toCents('$1,200')).toBe(120_000);
    expect(toCents('27.5')).toBe(2_750);
    expect(toCents('4.07 USD')).toBe(407);
    for (const bad of ['unknown', '', '-5', 'abc', undefined]) expect(toCents(bad)).toBeUndefined();
  });
});

describe('priceLodging', () => {
  const lines = ['LODGING | The Horton Hotel | 167 | 2', 'LODGING | Sleep Inn | 100 | 2', 'LODGING | Highland Cabins | 112 | 4'];

  it('rooms for the group × nights, low from the cheapest place, high from the dearest plus 15% for taxes and fees', () => {
    const s = store();
    const priced = priceLodging(answer(lines), 2, 3, s);
    // 3 people: 2 rooms in a place that sleeps 2 (167 → 668, 100 → 400), 1 where it sleeps 4 (112 × 2 = 224).
    expect(priced?.lowCents).toBe(22_400);
    expect(priced?.highCents).toBe(Math.ceil(66_800 * 1.15));
    expect(priced?.evidenceIds.length).toBeGreaterThan(0);
    expect(s.evidence.every((e) => e.url.startsWith('https://r.example/'))).toBe(true);
  });

  it('records what each source said as the claim', () => {
    const s = store();
    priceLodging(answer(lines), 2, 3, s);
    expect(s.evidence.map((e) => e.claim)).toContain('The Horton Hotel lists $167.00 per night, sleeps 2');
  });

  it('drops a line no citation covers: an uncited number is the model’s guess', () => {
    const priced = priceLodging(answer(lines, 1), 2, 3, store());
    expect(priced?.lowCents).toBe(66_800); // only the Horton line is cited
  });

  it('is unknown when nothing usable remains', () => {
    expect(priceLodging(answer(['LODGING | X | unknown | 2']), 2, 3, store())).toBeUndefined();
    expect(priceLodging(answer(['LODGING | X | 5 | 2']), 2, 3, store())).toBeUndefined(); // implausibly cheap
    expect(priceLodging(answer(lines, 0), 2, 3, store())).toBeUndefined();
  });

  it('assumes a room sleeps 2 when the answer does not say', () => {
    expect(priceLodging(answer(['LODGING | Inn | 100 | unknown']), 1, 3, store())?.lowCents).toBe(20_000);
  });
});

describe('priceFuel', () => {
  it('round trip at 30 to 20 mpg, with 25% extra driving on the upper estimate', () => {
    const priced = priceFuel(answer(['FUEL | 160 | 4.07']), store());
    expect(priced?.lowCents).toBe(Math.round((320 / 30) * 407));
    expect(priced?.highCents).toBe(Math.ceil((320 / 20) * 1.25 * 407));
    expect(priced?.lowCents).toBe(4_341);
    expect(priced?.highCents).toBe(8_140);
  });

  it('needs both numbers and a citation', () => {
    expect(priceFuel(answer(['FUEL | 160 | unknown']), store())).toBeUndefined();
    expect(priceFuel(answer(['FUEL | unknown | 4.07']), store())).toBeUndefined();
    expect(priceFuel(answer(['FUEL | 160 | 4.07'], 0), store())).toBeUndefined();
    expect(priceFuel(answer(['FUEL | 160 | 45']), store())).toBeUndefined(); // $45 a gallon is not a gas price
  });
});

describe('priceAdmissions', () => {
  it('sums per-person admission across every stop, using the widest range when sources differ', () => {
    const lines = ['ADMISSION | Grandfather Mountain State Park | 0', 'ADMISSION | Grandfather Mountain | 25', 'ADMISSION | Downtown Boone | 0'];
    const priced = priceAdmissions(answer(lines), ['Grandfather Mountain', 'Downtown Boone'], store());
    expect(priced).toMatchObject({ lowCents: 0, highCents: 2_500 });
  });

  it('is unknown if any stop has no sourced price: one gap is not treated as free', () => {
    const lines = ['ADMISSION | Grandfather Mountain | 25'];
    expect(priceAdmissions(answer(lines), ['Grandfather Mountain', 'Mystery Museum'], store())).toBeUndefined();
  });

  it('a stop with no admission is a real zero when a source says so', () => {
    expect(priceAdmissions(answer(['ADMISSION | Blue Ridge Parkway | 0']), ['Blue Ridge Parkway'], store())).toMatchObject({ lowCents: 0, highCents: 0 });
  });

  it('nothing to price is zero because there are no stops', () => {
    expect(priceAdmissions(answer([]), [], store())).toEqual({ lowCents: 0, highCents: 0, evidenceIds: [] });
  });
});

describe('priceMeals', () => {
  it('two restaurant meals a day over nights + 1 days, with 25% extra on the upper estimate', () => {
    const priced = priceMeals(answer(["MEAL | Dan'l Boone Inn | 27", 'MEAL | The Local | 16', 'MEAL | The Social | 24']), 2, store());
    expect(priced?.lowCents).toBe(6 * 1_600);
    expect(priced?.highCents).toBe(Math.ceil(6 * 2_700 * 1.25));
  });

  it('is unknown without a cited price in range', () => {
    expect(priceMeals(answer(['MEAL | X | unknown']), 2, store())).toBeUndefined();
    expect(priceMeals(answer(['MEAL | X | 1']), 2, store())).toBeUndefined();
  });
});

describe('priceOption', () => {
  const option = (): ResearchOption => ({
    optionId: 'gem-opt-1', name: 'Boone getaway', region: 'NC mountains', tags: ['hiking'], stops: [
      { label: 'Grandfather Mountain', location: 'Linville, NC', tags: ['hiking'], hours: 4, evidenceIds: [] },
    ],
    costs: [], perPersonCosts: [], evidenceIds: ['gem-0'], tradeoffs: ['A tradeoff.', 'Prices, where found, come from web search and are unverified estimates.'],
  });
  const request: ResearchRequest = { purpose: 'plan', revision: 1, origin: 'Chapel Hill', interests: [], nights: 2, groupSize: 3 };
  const replies = (prompt: string) =>
    prompt.includes('LODGING |') ? answer(['LODGING | Inn | 100 | 2'])
    : prompt.includes('FUEL |') ? answer(['FUEL | 160 | 4.07'])
    : prompt.includes('ADMISSION |') ? answer(['ADMISSION | Grandfather Mountain | 25'])
    : answer(['MEAL | Diner | 20']);

  it('replaces the costs with cited estimates and states every assumption', async () => {
    const s = store();
    const { option: priced, notes } = await priceOption(option(), request, async (p) => replies(p), s);
    expect(notes).toEqual([]);
    expect(priced.costs.map((c) => [c.costId, c.allocation, c.priceStatus])).toEqual([['lodging', 'equal_shared', 'estimate'], ['fuel', 'equal_shared', 'estimate']]);
    expect(priced.perPersonCosts.map((c) => [c.costId, c.priceStatus])).toEqual([['admissions', 'estimate'], ['food', 'estimate']]);
    expect(priced.perPersonCosts.every((c) => !('memberId' in c) && !('allocation' in c))).toBe(true);
    const text = priced.tradeoffs.join(' ');
    expect(text).toMatch(/15% extra/);
    expect(text).toMatch(/mpg/);
    expect(text).toMatch(/Parking and tolls are not included/);
    expect(text).toMatch(/Groceries and snacks are not included/);
    expect(text).toMatch(/unverified estimates/);
    // Every cost cites sources that exist in the store.
    const known = new Set(s.evidence.map((e) => e.evidenceId));
    for (const c of [...priced.costs, ...priced.perPersonCosts]) for (const id of c.evidenceIds) expect(known.has(id)).toBe(true);
    expect(priced.costs.every((c) => c.priceStatus !== 'estimate' || c.evidenceIds.length > 0)).toBe(true);
  });

  it('a failed lookup leaves just that price unknown, and says so', async () => {
    const ask = async (p: string) => {
      if (p.includes('FUEL |')) throw new Error('quota');
      return replies(p);
    };
    const { option: priced, notes } = await priceOption(option(), request, ask, store());
    expect(priced.costs.find((c) => c.costId === 'fuel')).toMatchObject({ priceStatus: 'unknown', lowCents: 0, evidenceIds: [] });
    expect(priced.costs.find((c) => c.costId === 'lodging')?.priceStatus).toBe('estimate');
    expect(notes.join(' ')).toMatch(/fuel lookup for Boone getaway failed/);
    expect(priced.tradeoffs.join(' ')).toMatch(/No sourced price was found for fuel/);
  });

  it('answers with no citations leave every price unknown, never zero', async () => {
    const uncited = async (p: string) => ({ steps: [{ type: 'model_output', content: [{ type: 'text', text: p.includes('MEAL |') ? 'MEAL | Diner | 20' : 'LODGING | Inn | 100 | 2', annotations: [] }] }] });
    const { option: priced } = await priceOption(option(), request, uncited, store());
    for (const c of [...priced.costs, ...priced.perPersonCosts]) expect(c.priceStatus).toBe('unknown');
  });

  it('does nothing without the trip length and group size', async () => {
    const ask = vi.fn();
    const { option: same } = await priceOption(option(), { ...request, nights: undefined }, ask, store());
    expect(ask).not.toHaveBeenCalled();
    expect(same).toEqual(option());
  });

  it('asks narrow questions that carry no money or names', async () => {
    const prompts: string[] = [];
    await priceOption(option(), request, async (p) => (prompts.push(p), replies(p)), store());
    expect(prompts).toHaveLength(4);
    for (const p of prompts) {
      expect(p).toMatch(/untrusted data/);
      expect(p).not.toMatch(/budget|maximum total|mason|alex|jordan/i);
    }
  });
});

describe('the Gemini provider with the price pass', () => {
  const mainLine = 'OPTION | Boone getaway | NC mountains | 177 | hiking | unknown | unknown | unknown | unknown | Hike~Linville, NC~4~hiking | A tradeoff.';
  const fetchFor = (calls: string[]) =>
    vi.fn(async (_url: string, init: RequestInit) => {
      const prompt = JSON.parse(init.body as string).input as string;
      calls.push(prompt);
      const body = prompt.includes('LODGING |') ? answer(['LODGING | Inn | 100 | 2'])
        : prompt.includes('FUEL |') ? answer(['FUEL | 160 | 4.07'])
        : prompt.includes('ADMISSION |') ? answer(['ADMISSION | Hike | 0'])
        : prompt.includes('MEAL |') ? answer(['MEAL | Diner | 20'])
        : answer([mainLine]);
      return new Response(JSON.stringify(body), { status: 200 });
    });
  const request: ResearchRequest = { purpose: 'plan', revision: 2, origin: 'Chapel Hill', searchRegion: 'NC mountains', interests: ['hiking'], nights: 2, groupSize: 3 };

  it('finds options, then prices them with separate lookups, sharing one evidence list', async () => {
    const calls: string[] = [];
    const provider = createResearchProvider({ mode: 'live', live: createGeminiProvider({ apiKey: 'k', fetch: fetchFor(calls) as never, now: () => NOW, lookupAdmissions: true, typicalCosts: false }) });
    const result = await provider.search(request);
    expect(calls).toHaveLength(5); // 1 search + 4 price lookups for the one option
    const [option] = result.options;
    expect([...option.costs, ...option.perPersonCosts].every((c) => c.priceStatus === 'estimate')).toBe(true);
    const ids = new Set(result.evidence.map((e) => e.evidenceId));
    expect(ids.size).toBe(result.evidence.length);
    for (const c of [...option.costs, ...option.perPersonCosts]) for (const id of c.evidenceIds) expect(ids.has(id)).toBe(true);
    expect(result.limitations.join(' ')).not.toMatch(/Some prices were not found/);
  });

  it('skips the price pass without trip length and group size, or when switched off, or for guide questions', async () => {
    for (const [req, config] of [
      [{ ...request, nights: undefined }, {}],
      [request, { priceLookups: false }],
      [{ ...request, purpose: 'guide' as const, question: 'rain?' }, {}],
    ] as const) {
      const calls: string[] = [];
      const provider = createGeminiProvider({ apiKey: 'k', fetch: fetchFor(calls) as never, now: () => NOW, ...config });
      await provider.search(req);
      expect(calls).toHaveLength(1);
    }
  });

  it('a price lookup that fails does not fail the search', async () => {
    let n = 0;
    const flaky = vi.fn(async (_url: string, init: RequestInit) => {
      n += 1;
      if (n > 1) return new Response('no', { status: 429 });
      return new Response(JSON.stringify(answer([mainLine])), { status: 200 });
    });
    const provider = createGeminiProvider({ apiKey: 'k', fetch: flaky as never, now: () => NOW, lookupAdmissions: true, typicalCosts: false });
    const result = await provider.search(request);
    expect(result.options).toHaveLength(1);
    expect([...result.options[0].costs, ...result.options[0].perPersonCosts].every((c) => c.priceStatus === 'unknown')).toBe(true);
    expect(result.limitations.join(' ')).toMatch(/lookup for Boone getaway failed/);
    expect(result.limitations.join(' ')).toMatch(/Some prices were not found/);
  });
});

describe('typical costs when nothing could be found', () => {
  const stop = { label: 'Grandfather Mountain', location: 'Linville, NC', tags: ['hiking'], hours: 4, evidenceIds: [] as string[] };
  const driveStop = { label: 'Drive to the mountains', location: 'Boone, NC', tags: [] as string[], hours: 3, evidenceIds: [] as string[] };
  const option = (drive: number | null = 150): ResearchOption => ({
    optionId: 'gem-opt-1', name: 'Boone getaway', region: 'NC mountains', tags: ['hiking'],
    ...(drive !== null ? { driveMinutesFromOrigin: drive } : {}),
    stops: [driveStop, stop], costs: [], perPersonCosts: [], evidenceIds: ['gem-0'], tradeoffs: ['A tradeoff.'],
  });
  const request: ResearchRequest = { purpose: 'plan', revision: 1, origin: 'Chapel Hill', interests: [], nights: 2, groupSize: 3 };
  const nothing = async () => answer(['no usable lines here'], 0);
  const typical = { typicalCosts: true, lookupAdmissions: false };

  it('fills every missing price with a labelled estimate: never zero, never presented as a found price', async () => {
    const { option: priced, notes } = await priceOption(option(), request, nothing, store(), typical);
    const byId = Object.fromEntries([...priced.costs, ...priced.perPersonCosts].map((c) => [c.costId, c]));
    // 2 rooms x 2 nights at $80 to $200 a room, plus 15% on the top.
    expect([byId.lodging.lowCents, byId.lodging.highCents]).toEqual([32_000, 92_000]);
    // 150 minutes at 0.7 to 1 mile a minute, round trip, 30 to 20 mpg, $3.00 to $4.50 a gallon, 25% extra on top.
    expect([byId.fuel.lowCents, byId.fuel.highCents]).toEqual([2_100, 8_438]);
    // 6 meals at $8 to $25, 25% extra on top.
    expect([byId.food.lowCents, byId.food.highCents]).toEqual([4_800, 18_750]);
    // One stop worth paying for at $0 to $15; the drive itself is not an attraction.
    expect([byId.admissions.lowCents, byId.admissions.highCents]).toEqual([0, 1_500]);
    for (const c of Object.values(byId)) {
      expect(c.priceStatus).toBe('estimate');
      expect(c.evidenceIds).toEqual([]);
      expect(c.label).toMatch(/typical cost, not a found price/i);
    }
    expect(priced.tradeoffs.join(' ')).toMatch(/typical costs/i);
    expect(notes.join(' ')).toMatch(/typical cost/i);
  });

  it('keeps fuel unknown when there is no drive time, because distance cannot be guessed', async () => {
    const { option: priced } = await priceOption(option(null), request, nothing, store(), typical);
    const fuel = priced.costs.find((c) => c.costId === 'fuel')!;
    expect(fuel.priceStatus).toBe('unknown');
    expect(priced.costs.find((c) => c.costId === 'lodging')!.priceStatus).toBe('estimate');
  });

  it('prefers a sourced price over the typical one, with its own label', async () => {
    const mixed = async (prompt: string) => (prompt.includes('LODGING |') ? answer(['LODGING | Inn | 100 | 2']) : answer(['nothing'], 0));
    const { option: priced } = await priceOption(option(), request, mixed, store(), typical);
    const lodging = priced.costs.find((c) => c.costId === 'lodging')!;
    expect(lodging.label).toBe('Lodging');
    expect(lodging.evidenceIds.length).toBeGreaterThan(0);
    expect(priced.costs.find((c) => c.costId === 'fuel')!.label).toMatch(/typical cost/i);
  });

  it('can skip the admissions lookup, which fails most often', async () => {
    const prompts: string[] = [];
    await priceOption(option(), request, async (p) => { prompts.push(p); return answer(['x'], 0); }, store(), typical);
    expect(prompts).toHaveLength(3);
    expect(prompts.join(' ')).not.toMatch(/ADMISSION \|/);
  });

  it('without the setting, a missing price stays unknown exactly as before', async () => {
    const { option: priced } = await priceOption(option(), request, nothing, store());
    expect([...priced.costs, ...priced.perPersonCosts].every((c) => c.priceStatus === 'unknown')).toBe(true);
  });
});

describe('research speed', () => {
  const lines = ['A', 'B', 'C', 'D'].map((n) => `OPTION | Option ${n} | NC mountains | 150 | hiking | unknown | unknown | unknown | unknown | Hike~Linville, NC~4~hiking | A tradeoff.`);
  const request: ResearchRequest = { purpose: 'plan', revision: 2, origin: 'Chapel Hill', searchRegion: 'NC mountains', interests: ['hiking'], nights: 2, groupSize: 3 };

  it('prices the options at the same time, but never more than six requests at once', async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls += 1;
      const prompt = JSON.parse(init.body as string).input as string;
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      const body = prompt.includes('LODGING |') ? answer(['LODGING | Inn | 100 | 2'])
        : prompt.includes('FUEL |') ? answer(['FUEL | 160 | 4.07'])
        : prompt.includes('MEAL |') ? answer(['MEAL | Diner | 20'])
        : answer(lines);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const result = await createGeminiProvider({ apiKey: 'k', fetch: fetchImpl as never, now: () => NOW }).search(request);
    // A fourth option was found but never priced, so it is not offered: "no prices found" would be untrue, we never looked.
    expect(result.options.map((o) => o.name)).toEqual(['Option A', 'Option B', 'Option C']);
    expect(calls).toBe(1 + 3 * 3);            // one search, then lodging, fuel and food for each of three options
    expect(peak).toBeGreaterThan(3);          // the options really were priced together
    expect(peak).toBeLessThanOrEqual(6);      // ... without flooding the service
  });

  it('cuts off a price lookup that hangs and uses a typical cost, so one slow answer cannot stall the whole search', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      const prompt = JSON.parse(init.body as string).input as string;
      if (prompt.includes('LODGING |')) {
        return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      const body = prompt.includes('FUEL |') ? answer(['FUEL | 160 | 4.07']) : prompt.includes('MEAL |') ? answer(['MEAL | Diner | 20']) : answer([lines[0]]);
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const started = Date.now();
    const result = await createGeminiProvider({ apiKey: 'k', fetch: fetchImpl as never, now: () => NOW, priceTimeoutMs: 60 }).search(request);
    expect(Date.now() - started).toBeLessThan(2_000);
    const lodging = result.options[0].costs.find((c) => c.costId === 'lodging')!;
    expect(lodging.priceStatus).toBe('estimate');
    expect(lodging.label).toMatch(/typical cost/i);
    expect(result.limitations.join(' ')).toMatch(/typical cost/i);
  });
});

describe('a named destination wins', () => {
  it('tells the model every option must be at the destination, and says nothing like that without one', () => {
    const base: ResearchRequest = { purpose: 'plan', revision: 1, interests: [] };
    expect(buildPrompt({ ...base, destination: 'Boone' })).toMatch(/every option must be in or right next to Boone/i);
    expect(buildPrompt({ ...base, searchRegion: 'NC mountains' })).not.toMatch(/every option must be in or right next to/i);
  });
});
