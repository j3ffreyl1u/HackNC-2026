import { describe, expect, it } from 'vitest';
import { createGeminiProvider, geminiConfigFromEnv } from '../../src/research/gemini.js';
import { createResearchProvider } from '../../src/research/provider.js';

// Live smoke test: makes one real, read-only Gemini request. It is skipped unless GEMINI_API_KEY is set, and a
// skipped run proves nothing about the live integration.
const config = geminiConfigFromEnv(process.env);

describe.skipIf(!config)('Gemini live smoke test', () => {
  it('returns grounded options whose every source is a real link', async () => {
    const provider = createResearchProvider({ mode: 'live', live: createGeminiProvider(config as NonNullable<typeof config>) });
    const result = await provider.search({
      purpose: 'plan', revision: 1, origin: 'Chapel Hill, NC', searchRegion: 'North Carolina mountains', maxTravelMinutes: 240,
      interests: ['hiking', 'town visit'], window: { startAt: '2026-11-13T17:00:00-05:00', endAt: '2026-11-15T20:00:00-05:00' },
    });
    console.log(`live smoke: ${result.options.length} options, ${result.evidence.length} sources`);
    console.log(result.evidence.map((e) => `${e.kind} ${e.url}`).join('\n'));
    console.log(result.limitations.join(' | '));
    expect(result.mode).toBe('live');
    expect(result.evidence.length).toBeGreaterThan(0);
    for (const e of result.evidence) expect(() => new URL(e.url)).not.toThrow();
    for (const o of result.options) expect(o.evidenceIds.length).toBeGreaterThan(0);
  }, 60_000);
});
