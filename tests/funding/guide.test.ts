import { expect, it, vi } from 'vitest';
import { approved } from './fixture.js';
import { createPlannerAdapter } from '../../src/app/planning-adapter.js';
import { createResearchProvider } from '../../src/research/provider.js';
import { defaultFixtures } from '../../src/research/fixtures.js';
import { answerGuideQuestion } from '../../src/planning/guide.js';
vi.mock('../../src/planning/guide.js', () => ({ answerGuideQuestion: vi.fn(async () => ({ text: 'Guide answer', evidence: [], mode: 'fixture' })) }));
it('answers guide questions from the plan alone: no pooled fund exists to be "covered by"', async () => {
  const provider = createResearchProvider({ mode: 'mock', fixtures: defaultFixtures });
  await createPlannerAdapter(provider, 'mock').guide!(await approved(), 'What is nearby?', '2026-10-10T12:00:00Z');
  expect(vi.mocked(answerGuideQuestion).mock.calls.at(-1)?.[3]).toEqual({ now: '2026-10-10T12:00:00Z' });
});
