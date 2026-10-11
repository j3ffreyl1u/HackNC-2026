import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EvidenceStore } from '../../src/research/grounding.js';
import { createLodgingLookup, createSerpApiHotels, lodgingFromHotels, serpApiConfigFromEnv, stayDates } from '../../src/research/serpapi.js';
import { priceOption } from '../../src/research/pricing.js';
import type { ResearchOption, ResearchRequest } from '../../src/research/types.js';

// `response` below is a small hand-made sample for exact arithmetic. The real shape was checked against one live search
// on 2026-10-11 (tests/research/captured/serpapi-boone.json, see the last test).
const response = {
  search_metadata: { status: 'Success', google_hotels_url: 'https://www.google.com/travel/search?q=hotels+in+boone' },
  properties: [
    { type: 'hotel', name: 'Mountain View Inn', link: 'https://mountainviewinn.example/book', rate_per_night: { lowest: '$110', extracted_lowest: 110 }, overall_rating: 4.4 },
    { type: 'hotel', name: 'Downtown Lodge', link: 'https://downtownlodge.example', rate_per_night: { lowest: '$145', extracted_lowest: 145 } },
    { type: 'hotel', name: 'Ridge Resort', rate_per_night: { lowest: '$320', extracted_lowest: 320 } },
    { type: 'hotel', name: 'Ad Without Price' },
    { type: 'hotel', name: 'Cheap Typo', rate_per_night: { lowest: '$3', extracted_lowest: 3 } },
  ],
};
const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
const query = { query: 'Hotels in Boone, NC', checkIn: '2026-11-14', checkOut: '2026-11-16', adults: 2 };

describe('createSerpApiHotels', () => {
  it('asks Google Hotels for the stay and keeps only listings with a believable nightly price', async () => {
    const fetchImpl = ok(response);
    const found = await createSerpApiHotels({ apiKey: 'k', fetch: fetchImpl })(query);
    const url = new URL((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://serpapi.com/search.json');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ engine: 'google_hotels', q: 'Hotels in Boone, NC', check_in_date: '2026-11-14', check_out_date: '2026-11-16', adults: '2', currency: 'USD', api_key: 'k' });
    expect(found?.hotels.map((h) => [h.name, h.nightlyCents])).toEqual([['Mountain View Inn', 11000], ['Downtown Lodge', 14500], ['Ridge Resort', 32000]]);
    expect(found?.searchUrl).toBe('https://www.google.com/travel/search?q=hotels+in+boone');
  });
  it('returns undefined when nothing is priced', async () => {
    expect(await createSerpApiHotels({ apiKey: 'k', fetch: ok({ properties: [{ name: 'x' }] }) })(query)).toBeUndefined();
    expect(await createSerpApiHotels({ apiKey: 'k', fetch: ok({ error: 'Google hasn\'t returned any results for this query.' }) })(query)).toBeUndefined();
  });
  it('throws without ever including the key in the message, for HTTP errors, network errors and API errors', async () => {
    const bad = [
      vi.fn(async () => new Response('{"error":"Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key"}', { status: 401 })),
      vi.fn(async () => { throw new Error('connect failed https://serpapi.com/search.json?api_key=SECRET123'); }),
      ok({ error: 'Your account has run out of searches.' }),
    ];
    for (const f of bad) {
      const err = await createSerpApiHotels({ apiKey: 'SECRET123', fetch: f as unknown as typeof fetch })(query).catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).not.toMatch(/SECRET123/);
      expect(String((err as Error).stack ?? '')).not.toMatch(/SECRET123/);
    }
  });
});

describe('search allowance (the plan is small)', () => {
  it('an identical search is answered from memory, so a re-search spends nothing', async () => {
    const fetchImpl = ok(response); const find = createSerpApiHotels({ apiKey: 'k', fetch: fetchImpl });
    await find(query); await find({ ...query, query: 'hotels in boone, nc' });   // same place, different capitalization
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await find({ ...query, checkIn: '2026-11-21', checkOut: '2026-11-23' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('concurrent identical searches share one request', async () => {
    const fetchImpl = ok(response); const find = createSerpApiHotels({ apiKey: 'k', fetch: fetchImpl });
    await Promise.all([find(query), find(query), find(query)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('stops asking after the allowance and says so, instead of spending more', async () => {
    const fetchImpl = ok(response); const find = createSerpApiHotels({ apiKey: 'k', fetch: fetchImpl, maxSearches: 2 });
    await find(query); await find({ ...query, checkIn: '2026-11-21', checkOut: '2026-11-23' });
    await expect(find({ ...query, checkIn: '2026-12-05', checkOut: '2026-12-07' })).rejects.toThrow(/allowance/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('a failed search is not remembered or counted as an answer, but still counts against the allowance', async () => {
    let calls = 0;
    const flaky = vi.fn(async () => { calls += 1; return calls === 1 ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(response), { status: 200 }); }) as unknown as typeof fetch;
    const find = createSerpApiHotels({ apiKey: 'k', fetch: flaky, maxSearches: 5 });
    await expect(find(query)).rejects.toThrow();
    expect((await find(query))?.hotels.length).toBe(3);
  });
  it('the allowance can be set from the environment', () => {
    expect(serpApiConfigFromEnv({ SERPAPI_API_KEY: 'abc', SERPAPI_MAX_SEARCHES: '10' })).toEqual({ apiKey: 'abc', maxSearches: 10 });
    expect(serpApiConfigFromEnv({ SERPAPI_API_KEY: 'abc', SERPAPI_MAX_SEARCHES: 'lots' })).toEqual({ apiKey: 'abc' });
  });
});

describe('lodgingFromHotels', () => {
  const found = { hotels: [{ name: 'Mountain View Inn', nightlyCents: 11000, url: 'https://mountainviewinn.example/book' }, { name: 'Downtown Lodge', nightlyCents: 14500, url: 'https://downtownlodge.example' }, { name: 'Ridge Resort', nightlyCents: 32000 }], searchUrl: 'https://www.google.com/travel/search?q=x' };
  it('does the arithmetic in code: rooms for the group x nights, cheapest low, upper-middle high with taxes, every figure cited', () => {
    const store = new EvidenceStore('2026-10-11T00:00:00.000Z');
    const priced = lodgingFromHotels(found, 2, 3, '2026-11-14', store)!;
    expect(priced.lowCents).toBe(11000 * 2 * 2);                       // 2 rooms for 3 people, 2 nights, cheapest listing
    expect(priced.highCents).toBeGreaterThan(14500 * 2 * 2);           // at least the middle listing, plus taxes and fees
    expect(priced.highCents).toBeLessThanOrEqual(Math.ceil(32000 * 2 * 2 * 1.15));
    expect(priced.evidenceIds.length).toBeGreaterThan(0);
    const ev = store.evidence.find((e) => e.evidenceId === priced.evidenceIds[0])!;
    expect(ev.url).toMatch(/^https:\/\//);
    expect(ev.claim).toMatch(/Mountain View Inn.*\$110.*Nov 14/);
    expect(ev.uncertainty).toMatch(/not a booking|availability/i);
  });
  it('is unknown (undefined) with no listings, never zero', () => {
    expect(lodgingFromHotels({ hotels: [] }, 2, 3, '2026-11-14', new EvidenceStore('x'))).toBeUndefined();
  });
});

describe('stayDates', () => {
  it('uses the first night of the group\'s window and the trip length', () => {
    expect(stayDates({ startAt: '2026-11-14T05:00:00Z', endAt: '2026-11-18T05:00:00Z' }, 2, 'America/New_York')).toEqual({ checkIn: '2026-11-14', checkOut: '2026-11-16' });
  });
  it('refuses dates in the past', () => {
    expect(stayDates({ startAt: '2020-01-01T00:00:00Z', endAt: '2020-01-05T00:00:00Z' }, 2, 'America/New_York', '2026-10-11')).toBeUndefined();
  });
});

describe('priceOption with a live hotel lookup', () => {
  const option: ResearchOption = { optionId: 'o', name: 'Boone weekend', region: 'NC mountains', tags: [], stops: [{ label: 'Hike', location: 'Boone, NC', tags: ['hiking'], hours: 3, evidenceIds: [] }], costs: [], perPersonCosts: [], evidenceIds: [], tradeoffs: [] };
  const request: ResearchRequest = { purpose: 'plan', revision: 1, interests: [], nights: 2, groupSize: 3, window: { startAt: '2026-11-14T05:00:00Z', endAt: '2026-11-18T05:00:00Z' } };
  const noAnswer = async (_prompt: string) => ({ output: [] });
  it('uses the sourced hotel price and does not spend a Gemini lodging search', async () => {
    const ask = vi.fn(noAnswer);
    const store = new EvidenceStore('2026-10-11T00:00:00.000Z');
    const out = await priceOption(option, request, ask, store, { typicalCosts: true, lookupLodging: async (o, r, s) => lodgingFromHotels({ hotels: [{ name: 'Mountain View Inn', nightlyCents: 11000, url: 'https://mountainviewinn.example' }] }, r.nights!, r.groupSize!, '2026-11-14', s) });
    const lodging = out.option.costs.find((c) => c.costId === 'lodging')!;
    expect(lodging.priceStatus).toBe('estimate'); expect(lodging.evidenceIds.length).toBeGreaterThan(0); expect(lodging.label).not.toMatch(/typical/i);
    expect(ask.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/places to stay/);
  });
  it('falls back to Gemini, then to a labelled typical cost, when the hotel lookup finds nothing or fails', async () => {
    for (const lookupLodging of [async () => undefined, async () => { throw new Error('quota'); }]) {
      const out = await priceOption(option, request, vi.fn(noAnswer), new EvidenceStore('x'), { typicalCosts: true, lookupLodging });
      expect(out.option.costs.find((c) => c.costId === 'lodging')!.label).toMatch(/typical cost/);
    }
  });
});

describe('createLodgingLookup', () => {
  const trail: ResearchOption = { optionId: 't', name: 'Falls loop', region: 'High Country', tags: [], stops: [{ label: 'Hike', location: 'Price Lake Recreation Area', tags: ['hiking'], hours: 3, evidenceIds: [] }], costs: [], perPersonCosts: [], evidenceIds: [], tradeoffs: [] };
  const town: ResearchOption = { ...trail, optionId: 'w', stops: [{ label: 'Walk', location: 'King Street', tags: [], hours: 2, evidenceIds: [] }] };
  const req: ResearchRequest = { purpose: 'plan', revision: 1, interests: [], nights: 2, groupSize: 3, window: { startAt: '2999-11-14T05:00:00Z', endAt: '2999-11-18T05:00:00Z' } };
  it('searches the group\'s destination town, so every option there shares one search', async () => {
    const fetchImpl = ok(response);
    const lookup = createLodgingLookup(createSerpApiHotels({ apiKey: 'k', fetch: fetchImpl }));
    const store = new EvidenceStore('x');
    const [a, b] = await Promise.all([lookup(trail, { ...req, destination: 'Boone' }, store), lookup(town, { ...req, destination: 'Boone' }, store)]);
    expect(a && b).toBeTruthy(); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URL((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string).searchParams.get('q')).toBe('Hotels in Boone');
  });
  it('without a destination it falls back to the first stop, then the region', async () => {
    const fetchImpl = ok(response);
    await createLodgingLookup(createSerpApiHotels({ apiKey: 'k', fetch: fetchImpl }))(trail, req, new EvidenceStore('x'));
    expect(new URL((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string).searchParams.get('q')).toBe('Hotels in Price Lake Recreation Area');
  });
  it('does nothing without a window, trip length or group size (never guesses dates)', async () => {
    const fetchImpl = ok(response); const lookup = createLodgingLookup(createSerpApiHotels({ apiKey: 'k', fetch: fetchImpl }));
    expect(await lookup(trail, { ...req, window: undefined }, new EvidenceStore('x'))).toBeUndefined();
    expect(await lookup(trail, { ...req, nights: undefined }, new EvidenceStore('x'))).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('serpApiConfigFromEnv', () => {
  it('is off without a key and on with one', () => {
    expect(serpApiConfigFromEnv({})).toBeUndefined();
    expect(serpApiConfigFromEnv({ SERPAPI_API_KEY: '  ' })).toBeUndefined();
    expect(serpApiConfigFromEnv({ SERPAPI_API_KEY: 'abc' })).toEqual({ apiKey: 'abc' });
  });
});

describe('a real captured response (Boone, 2026-10-11)', () => {
  const real = readFileSync(new URL('./captured/serpapi-boone.json', import.meta.url), 'utf8');
  it('parses every listing with a believable nightly rate and prices a 3-person, 2-night stay with citations', async () => {
    const found = await createSerpApiHotels({ apiKey: 'k', fetch: (async () => new Response(real, { status: 200 })) as unknown as typeof fetch })(query);
    expect(found!.hotels.length).toBeGreaterThanOrEqual(10);
    expect(found!.hotels.every((h) => h.nightlyCents >= 2_000 && h.name.length > 0)).toBe(true);
    expect(found!.searchUrl).toMatch(/^https:\/\/www\.google\.com\/travel/);
    const store = new EvidenceStore('2026-10-11T00:00:00.000Z');
    const priced = lodgingFromHotels(found!, 2, 3, '2026-11-14', store)!;
    expect(priced.lowCents).toBeGreaterThan(0); expect(priced.highCents).toBeGreaterThan(priced.lowCents);
    expect(store.evidence.every((e) => /^https:\/\//.test(e.url) && /per night/.test(e.claim))).toBe(true);
  });
});
