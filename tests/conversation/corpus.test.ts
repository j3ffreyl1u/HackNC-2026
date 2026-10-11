import { describe, expect, it } from 'vitest';
import { MockIntentModel } from '../../src/conversation/mock.js';
import { corpus } from './corpus.js';
import { check, runCase } from './corpus-harness.js';

/**
 * Deterministic half of the simulated live test (no network). With a model that understands nothing:
 *  - every case marked `rules: true` must already be right;
 *  - every case marked `rules: false` must have been HANDED to the model (the automatic handoff), never dropped.
 * The live half (real Gemini) is tests/conversation/corpus.live.test.ts.
 */
describe('simulated live test: rules and automatic model handoff', () => {
  for (const testCase of corpus.filter((x) => x.rules)) {
    it(`rules handle: ${testCase.say}`, async () => {
      const outcome = await runCase(testCase, new MockIntentModel());
      expect(check(testCase, outcome), JSON.stringify(outcome)).toEqual([]);
    });
  }
  for (const testCase of corpus.filter((x) => !x.rules)) {
    it(`handed to the model: ${testCase.say}`, async () => {
      const model = new MockIntentModel();
      await runCase(testCase, model);
      expect(model.calls.length, 'the parser must pass what it does not recognise to the model').toBeGreaterThan(0);
    });
  }
});
