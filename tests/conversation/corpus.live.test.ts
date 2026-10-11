import { appendFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGeminiIntentModel } from '../../src/conversation/gemini.js';
import { corpus } from './corpus.js';
import { check, runCase } from './corpus-harness.js';

/**
 * Live half of the simulated live test: every corpus case through the real parser AND real Gemini.
 * Skipped unless RUN_LIVE_GEMINI=1 and GEMINI_API_KEY/GEMINI_MODEL are set (it makes ~100 API calls).
 * `soft` cases are reported but never fail. Set CORPUS_REPORT=/path to also write a readable report.
 */
const live = process.env.RUN_LIVE_GEMINI === '1' && !!process.env.GEMINI_API_KEY && !!process.env.GEMINI_MODEL;

describe.skipIf(!live)('simulated live test with real Gemini', () => {
  it('every hard case is right end to end', { timeout: 600_000 }, async () => {
    const model = createGeminiIntentModel({ apiKey: process.env.GEMINI_API_KEY!, model: process.env.GEMINI_MODEL!, timeoutMs: 45_000 });
    const report = process.env.CORPUS_REPORT;
    if (report) writeFileSync(report, '');
    const failures: string[] = [];
    let pass = 0; let softFail = 0;
    const queue = corpus.map((c, i) => ({ c, i }));
    const results: string[] = new Array(corpus.length).fill('');
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const outcome = await runCase(job.c, model);
        const bad = check(job.c, outcome);
        const tag = bad.length === 0 ? 'PASS' : job.c.soft ? 'soft-fail' : 'FAIL';
        results[job.i] = `${tag}  ${JSON.stringify(job.c.say)}${bad.length ? '\n        ' + bad.join('; ') + `\n        got: ${JSON.stringify({ u: outcome.updates.map((u) => [u.field, u.value, u.maxTravelMinutes, u.vehicleAvailable]), a: outcome.actions, r: outcome.reply.slice(0, 90) })}` : ''}`;
        if (bad.length === 0) pass++; else if (job.c.soft) softFail++; else failures.push(results[job.i]!);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (report) appendFileSync(report, results.join('\n') + `\n\n${pass} pass, ${softFail} soft-fail, ${failures.length} FAIL of ${corpus.length}\n`);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
