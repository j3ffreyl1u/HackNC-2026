import { createChatAdapter } from './conversation-adapter.js';
import { createPlannerAdapter } from './planning-adapter.js';
import { createApplicationRuntime } from './runtime.js';
import { MockMessenger } from '../conversation/mock.js';
import { createResearchProvider } from '../research/provider.js';
import { demoResearchFixtures, realisticResearchFixtures } from './research-fixtures.js';
import type { Repository, TripEnrollment, TripState } from '../contracts/index.js';

/** Drives the real A/B modules through provider events; every price/source is synthetic. */
export async function runMockDemo(repository: Repository, enrollment: TripEnrollment, initial: TripState, options: { realistic?: boolean } = {}) {
  const defaultFixtures = options.realistic ? realisticResearchFixtures : demoResearchFixtures;
  const expectedTotals = options.realistic ? [32800, 50000] : [18000, 19000];
  const revisedCap = options.realistic ? 45000 : 18000;
  await repository.bootstrapTrip(enrollment, { ...initial, memberConstraints: [], groupConstraints: [], candidates: [], acceptances: [], pendingQuestions: [], status: 'gathering' });
  const messenger = new MockMessenger();
  const { conversation } = await createChatAdapter(enrollment, initial.timeZone ?? 'America/New_York', 'mock', {}, messenger);
  const runtime = createApplicationRuntime({ repository, conversation, planner: createPlannerAdapter(createResearchProvider({ mode: 'mock', fixtures: defaultFixtures }), enrollment.groupSpaceId), tripId: enrollment.tripId });
  let sequence = 0;
  const say = async (id: string, text: string, privateMessage = false) => {
    const member = enrollment.participants.find(p => p.memberId === id)!;
    const messageId = `demo:${++sequence}`;
    await messenger.emit({ messageId, providerUserId: member.providerUserId, spaceId: privateMessage ? `dm:${id}` : enrollment.groupSpaceId, isDirect: privateMessage, fromSelf: false, occurredAt: '2026-10-10T16:00:00Z', text });
    await runtime.waitForIdle();
  };
  try {
    await runtime.start();
    for (const [index, member] of enrollment.participants.entries()) {
      const cap = initial.memberConstraints.find(r => r.memberId === member.memberId && r.field === 'budget');
      await say(member.memberId, `my max is $${cap?.field === 'budget' ? cap.value / 100 : [200, 250, 300][index]}`, true);
      await say(member.memberId, 'free 2026-11-14 to 2026-11-17');
      await say(member.memberId, 'I like hiking and town visit');
    }
    const first = enrollment.participants[0].memberId;
    await say(first, 'leaving from Chapel Hill');
    await say(first, '2 nights');
    await say(first, 'I have a car');
    await say(first, 'region is NC mountains');
    await say(first, 'show plans');
    let state = (await repository.loadTrip(enrollment.tripId))!;
    const totals = state.candidates.filter(c => c.feasibility.feasible).map(c => c.perPersonTotals[0].highCents).sort((a, b) => a - b);
    if (JSON.stringify(totals) !== JSON.stringify(expectedTotals)) throw new Error(`Demo expected ${JSON.stringify(expectedTotals)}, got ${JSON.stringify(totals)}`);
    const expensive = state.candidates.find(c => c.perPersonTotals[0].highCents === expectedTotals[1])!;
    await say(first, `pick ${expensive.candidateId} v${state.revision}`);
    await say(first, `accept ${expensive.candidateId} v${state.revision}`);
    const oldRevision = state.revision;
    await say(first, `my max is $${revisedCap / 100}`, true);
    state = (await repository.loadTrip(enrollment.tripId))!;
    if (state.revision <= oldRevision || state.acceptances.length || state.candidates.some(c => c.feasibility.feasible && c.perPersonTotals[0].highCents > revisedCap)) throw new Error('Constraint revision did not invalidate the old plan.');
    const cheaper = state.candidates.find(c => c.feasibility.feasible && c.perPersonTotals[0].highCents === expectedTotals[0])!;
    if (!cheaper) throw new Error('The cheaper option was not retained.');
    await say(first, `pick ${cheaper.candidateId} v${state.revision}`);
    for (const member of enrollment.participants) await say(member.memberId, `accept ${cheaper.candidateId} v${state.revision}`);
    state = (await repository.loadTrip(enrollment.tripId))!;
    if (state.status !== 'approved' || state.acceptances.length !== 3) throw new Error('Exact-version approval failed.');
    await say(first, 'guide: It is raining. What can we do near the next stop?');
    const guide = messenger.sent.at(-1)!.text;
    if (!guide.includes('approved plan') || !guide.includes('fixtures.invalid/free-indoor')) throw new Error('Contextual sourced guide response failed.');
    return { state, guide, transcript: messenger.sent, totals };
  } finally { await runtime.stop(); }
}
