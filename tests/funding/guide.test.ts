import { expect, it, vi } from 'vitest';
import { approved } from './fixture.js';
import { createPlannerAdapter } from '../../src/app/planning-adapter.js';
import { createResearchProvider } from '../../src/research/provider.js';
import { defaultFixtures } from '../../src/research/fixtures.js';
import { answerGuideQuestion } from '../../src/planning/guide.js';
vi.mock('../../src/planning/guide.js', () => ({ answerGuideQuestion: vi.fn(async () => ({ text: 'Guide answer', evidence: [], mode: 'fixture' })) }));
it('passes the remaining fund into B guide options and omits it when no fund exists', async () => {
  const provider = createResearchProvider({ mode: 'mock', fixtures: defaultFixtures });
  const state = await approved();
  const funded = createPlannerAdapter(provider, 'mock', { fundContext: async () => ({ remainingDollars: 35 }) });
  await funded.guide!(state, 'What is nearby?', '2026-10-10T12:00:00Z');
  expect(vi.mocked(answerGuideQuestion).mock.calls.at(-1)?.[3]).toEqual({ now: '2026-10-10T12:00:00Z', fund: { remainingDollars: 35 } });
  await createPlannerAdapter(provider, 'mock').guide!(state, 'What is nearby?');
  expect(vi.mocked(answerGuideQuestion).mock.calls.at(-1)?.[3]).not.toHaveProperty('fund');
});
