import { describe, expect, it, vi } from 'vitest';
import { defaultFixtures, searchFixtures } from '../../src/research/fixtures.js';
import { createFixtureProvider, createResearchProvider, guardLiveProvider } from '../../src/research/provider.js';
import { ResearchError, type ResearchProvider, type ResearchRequest, type ResearchResult } from '../../src/research/types.js';

const NOW = () => '2026-10-10T12:00:00.000Z';
const request = (over: Partial<ResearchRequest> = {}): ResearchRequest => ({
  purpose: 'plan', revision: 4, origin: 'Chapel Hill', searchRegion: 'NC mountains', maxTravelMinutes: 240, interests: ['hiking', 'town visit'], ...over,
});
const live = (result: Partial<ResearchResult> | Error): ResearchProvider => ({
  mode: 'live',
  search: vi.fn(async (req: ResearchRequest) => {
    if (result instanceof Error) throw result;
    return { mode: 'live', revision: req.revision, retrievedAt: NOW(), options: [], evidence: [], limitations: [], ...result } as ResearchResult;
  }),
});

describe('fixture provider', () => {
  it('is labeled fixture and echoes the revision it was asked about', async () => {
    const result = await createFixtureProvider(defaultFixtures, NOW).search(request());
    expect(result.mode).toBe('fixture');
    expect(result.revision).toBe(4);
    expect(result.limitations.join(' ')).toMatch(/fixture data/);
    expect(result.limitations.join(' ')).toMatch(/Availability was not checked/);
  });

  it('every source is a labeled fixture with a link, date and kind', async () => {
    const { evidence } = await createFixtureProvider(defaultFixtures, NOW).search(request());
    expect(evidence.length).toBeGreaterThan(0);
    for (const e of evidence) {
      expect(e.url).toMatch(/^https:\/\/fixtures\.invalid\//);
      expect(e.title).toMatch(/^FIXTURE:/);
      expect(e.retrievedAt).toBeTruthy();
      expect(['official', 'community', 'estimate', 'web']).toContain(e.kind);
    }
  });

  it('ranks options by how many stated interests they cover, deterministically (ties by ID)', async () => {
    const { options } = await createFixtureProvider(defaultFixtures, NOW).search(request());
    expect(options.map((o) => o.optionId)).toEqual(['hanging-rock', 'asheville', 'boone-cabin']);
  });

  it('honors the drive limit and a named destination', async () => {
    const near = await createFixtureProvider(defaultFixtures, NOW).search(request({ maxTravelMinutes: 160 }));
    expect(near.options.map((o) => o.optionId)).toEqual(['hanging-rock']);
    const named = await createFixtureProvider(defaultFixtures, NOW).search(request({ destination: 'Asheville', searchRegion: undefined, maxTravelMinutes: undefined }));
    expect(named.options.map((o) => o.optionId)).toEqual(['asheville']);
  });

  it('returns nothing, and says so, when nothing matches', async () => {
    const result = await createFixtureProvider(defaultFixtures, NOW).search(request({ destination: 'Nowhereville' }));
    expect(result.options).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/No fixture option matched/);
  });

  it('returns only the sources its options cite', async () => {
    const result = await createFixtureProvider(defaultFixtures, NOW).search(request({ maxTravelMinutes: 160 }));
    const cited = new Set(result.options.flatMap((o) => [...o.evidenceIds, ...o.perPersonCosts.flatMap((c) => c.evidenceIds), ...o.stops.flatMap((s) => s.evidenceIds), ...o.costs.flatMap((c) => c.evidenceIds)]));
    expect(result.evidence.every((e) => cited.has(e.evidenceId))).toBe(true);
  });

  it('keeps an unknown price unknown and says so', async () => {
    const { options, limitations } = await createFixtureProvider(defaultFixtures, NOW).search(request());
    const lodging = options.find((o) => o.optionId === 'asheville')?.costs.find((c) => c.costId === 'lodging');
    expect(lodging?.priceStatus).toBe('unknown');
    expect(limitations.join(' ')).toMatch(/not found and are marked unknown/);
  });

  it('serves rainy-day guide options only for a guide question about rain', async () => {
    const rain = await createFixtureProvider(defaultFixtures, NOW).search(request({ purpose: 'guide', question: "It's raining, what can we do?" }));
    expect(rain.options.map((o) => o.optionId)).toEqual(['rainy-day-boone']);
    const plan = await createFixtureProvider(defaultFixtures, NOW).search(request());
    expect(plan.options.map((o) => o.optionId)).not.toContain('rainy-day-boone');
  });

  it('keeps the conflicting rainy-day sources visible', async () => {
    const rain = await createFixtureProvider(defaultFixtures, NOW).search(request({ purpose: 'guide', question: 'rainy day' }));
    expect(rain.evidence.map((e) => e.evidenceId)).toEqual(expect.arrayContaining(['fx-rain-museum', 'fx-rain-crowded']));
  });

  it('does not mutate the shared fixture data', async () => {
    const before = structuredClone(defaultFixtures);
    const result = searchFixtures(defaultFixtures, request(), NOW());
    result.options[0].name = 'changed';
    result.evidence[0].claim = 'changed';
    expect(defaultFixtures).toEqual(before);
  });
});

describe('guardLiveProvider', () => {
  it('passes through a valid live result', async () => {
    const source = { evidenceId: 'g1', url: 'https://visitnc.example.org/x', title: 'Visit NC', retrievedAt: NOW(), kind: 'official' as const, claim: 'Park is open.' };
    const provider = guardLiveProvider(live({ evidence: [source] }));
    expect(provider.mode).toBe('live');
    expect((await provider.search(request())).evidence).toEqual([source]);
  });

  it('turns any failure into RESEARCH_UNAVAILABLE, with no fixture fallback', async () => {
    const provider = guardLiveProvider(live(new Error('socket hang up')));
    await expect(provider.search(request())).rejects.toMatchObject({ name: 'ResearchError', code: 'RESEARCH_UNAVAILABLE', reason: 'request_failed' });
    await expect(provider.search(request())).rejects.not.toThrow(/socket hang up/);
  });

  it('keeps a ResearchError the provider raised itself', async () => {
    const own = new ResearchError('unsourced', 'no source');
    await expect(guardLiveProvider(live(own)).search(request())).rejects.toBe(own);
  });

  it('refuses a result that claims to be fixture data', async () => {
    await expect(guardLiveProvider(live({ mode: 'fixture' })).search(request())).rejects.toMatchObject({ reason: 'invalid_result' });
  });

  it('refuses malformed output instead of passing it on', async () => {
    const bad = { evidenceId: 'g1', url: '', title: 't', retrievedAt: NOW(), kind: 'official' as const, claim: 'c' };
    await expect(guardLiveProvider(live({ evidence: [bad] })).search(request())).rejects.toMatchObject({ reason: 'invalid_result' });
  });
});

describe('createResearchProvider', () => {
  it('mock mode uses fixtures and is labeled so', async () => {
    const provider = createResearchProvider({ mode: 'mock', fixtures: defaultFixtures });
    expect(provider.mode).toBe('fixture');
    expect((await provider.search(request())).mode).toBe('fixture');
  });

  it('live mode without a configured provider fails loudly and never serves fixture data', async () => {
    const provider = createResearchProvider({ mode: 'live', fixtures: defaultFixtures });
    expect(provider.mode).toBe('live');
    await expect(provider.search(request())).rejects.toMatchObject({ code: 'RESEARCH_UNAVAILABLE', reason: 'not_configured' });
  });

  it('live mode with a failing provider also never falls back to fixtures', async () => {
    const provider = createResearchProvider({ mode: 'live', fixtures: defaultFixtures, live: live(new Error('503')) });
    await expect(provider.search(request())).rejects.toMatchObject({ reason: 'request_failed' });
  });

  it('mock mode needs fixture data', () => {
    expect(() => createResearchProvider({ mode: 'mock' })).toThrow(ResearchError);
  });

  it('never sends private limits: the request type has no budget or calendar fields', () => {
    const keys = Object.keys(request({ question: 'q', destination: 'd', window: { startAt: 'a', endAt: 'b' } }));
    expect(keys.some((k) => /budget|cap|calendar|busy|cents/i.test(k))).toBe(false);
  });
});
