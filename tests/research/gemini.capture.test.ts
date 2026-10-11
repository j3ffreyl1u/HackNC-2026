import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateCandidates, planTrip } from '../../src/planning/generate.js';
import { createGeminiProvider, parseInteraction } from '../../src/research/gemini.js';
import { createResearchProvider } from '../../src/research/provider.js';
import type { ResearchRequest } from '../../src/research/types.js';
import { NOW, readyState } from '../planning/fixtures.js';

// A real response from the live API (see captured/README.txt), so the parser is checked against what Gemini
// actually returns and not only against payloads built from the documentation.
const captured = JSON.parse(readFileSync(new URL('./captured/gemini-interaction.json', import.meta.url), 'utf8'));
const request: ResearchRequest = {
  purpose: 'plan', revision: 1, origin: 'Chapel Hill', searchRegion: 'NC mountains', maxTravelMinutes: 240, interests: ['hiking', 'town visit'],
};

describe('parseInteraction on a real captured response', () => {
  const result = parseInteraction(captured, request, NOW);

  it('reads sourced options with real citations', () => {
    expect(result.mode).toBe('live');
    expect(result.options.length).toBeGreaterThanOrEqual(2);
    expect(result.evidence.length).toBeGreaterThan(0);
    for (const o of result.options) expect(o.evidenceIds.length).toBeGreaterThan(0);
  });

  it('keeps the citation links, which are Google redirect URLs, and names the real site from the title', () => {
    for (const e of result.evidence) {
      expect(e.url).toMatch(/^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//);
      expect(e.title).toMatch(/^[a-z0-9.-]+\.[a-z]+$/);
      expect(['web', 'official', 'community']).toContain(e.kind);
    }
  });

  it('records the cited text as the claim and the retrieval time', () => {
    for (const e of result.evidence) {
      expect(e.claim.length).toBeGreaterThan(10);
      expect(e.retrievedAt).toBe(NOW);
    }
  });

  it('prices the model did not find stay unknown, never zero or invented', () => {
    for (const o of result.options) {
      for (const c of [...o.costs, ...o.perPersonCosts]) {
        expect(c.priceStatus).toBe('unknown');
        expect(c.evidenceIds).toEqual([]);
      }
    }
    expect(result.limitations.join(' ')).toMatch(/prices were not found/);
  });

  it('keeps stops whose visit length is unknown, planning them at an assumed length it admits to', () => {
    const stops = result.options.flatMap((o) => o.stops);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every((s) => s.hours > 0)).toBe(true);
    expect(result.options.flatMap((o) => o.tradeoffs).join(' ')).toMatch(/Visit lengths weren't found/);
  });

  it('carries the search suggestions HTML for display', () => {
    expect(result.searchSuggestionsHtml?.length).toBeGreaterThan(0);
  });
});

describe('a live result in the planner', () => {
  const live = () =>
    createResearchProvider({
      mode: 'live',
      live: createGeminiProvider({ apiKey: 'test', fetch: (async () => new Response(JSON.stringify(captured), { status: 200 })) as never, now: () => NOW, typicalCosts: false }),
    });

  it('proposes nothing when no price at all was found, and says so instead of showing $0', async () => {
    const outcome = await planTrip(readyState(), live());
    expect(outcome.mode).toBe('live');
    expect(outcome.candidates).toEqual([]);
    const text = outcome.replies.map((r) => r.text).join('\n');
    expect(text).toMatch(/couldn't find any prices/);
    expect(text).not.toMatch(/\$0\.00/);
    expect(text).not.toMatch(/fixture data/i);
  });

  it('never yields a candidate that could be approved', async () => {
    const candidates = await generateCandidates(readyState(), live());
    expect(candidates.some((c) => c.feasibility.feasible)).toBe(false);
  });
});


describe('the same captured answer with typical costs switched on (the live default)', () => {
  const live = () =>
    createResearchProvider({
      mode: 'live',
      live: createGeminiProvider({ apiKey: 'test', fetch: (async () => new Response(JSON.stringify(captured), { status: 200 })) as never, now: () => NOW }),
    });

  it('never shows a zero, never calls a typical cost a found price, and says which costs are typical', async () => {
    const outcome = await planTrip(readyState({ mason: 90_000, alex: 90_000, jordan: 90_000 }), live());
    const text = outcome.replies.map((r) => r.text).join('\n');
    expect(text).not.toMatch(/\$0\.00/);
    expect(text).toMatch(/typical cost/i);
    const costs = outcome.candidates.flatMap((c) => c.costs);
    expect(costs.length).toBeGreaterThan(0);
    for (const c of costs) {
      expect(c.priceStatus).not.toBe('verified');
      if (/typical cost/i.test(c.label)) {
        expect(c.evidenceIds).toEqual([]);
        expect(c.highCents).toBeGreaterThan(0);
      }
    }
  });
});
