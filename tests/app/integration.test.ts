import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { runMockDemo } from '../../src/app/mock-demo.js';
import { createPlannerAdapter, toPlanningState } from '../../src/app/planning-adapter.js';
import { localMidnight, createChatAdapter } from '../../src/app/conversation-adapter.js';
import { createResearchProvider } from '../../src/research/provider.js';
import { defaultFixtures } from '../../src/research/fixtures.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';

describe('integrated chat planner', () => {
  it('runs three actors, revises $190/$180 options, renews approval, answers guide, and persists safely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trip-integration-'));
    const path = join(dir, 'trip.sqlite');
    let repository = SqliteTripRepository.open(path);
    try {
      const fixture = await loadDemoTrip('tests/fixtures/trip.json');
      const result = await runMockDemo(repository, fixture.enrollment, fixture.state);
      expect(result.totals).toEqual([18000, 19000]);
      expect(result.state.status).toBe('approved');
      expect(result.guide).toContain('approved plan');
      expect(result.guide).toContain('fixtures.invalid/free-indoor');
      expect(result.transcript.filter(m => m.audience.kind === 'group').map(m => m.text).join('\n')).not.toMatch(/\$200|\$250|\$300|over your maximum/);
      const snapshot = await repository.getPublicSnapshot(result.state.tripId);
      expect(snapshot?.revision).toBe(result.state.revision);
      expect(snapshot).not.toHaveProperty('memberConstraints');
      repository.close();
      repository = SqliteTripRepository.open(path);
      expect(await repository.loadTrip(result.state.tripId)).toEqual(result.state);
      expect(await repository.pendingMessages()).toEqual([]);
    } finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves DST when converting inclusive chat dates', () => {
    expect(localMidnight('2026-11-01', 'America/New_York')).toBe('2026-11-01T04:00:00.000Z');
    expect(localMidnight('2026-11-02', 'America/New_York')).toBe('2026-11-02T05:00:00.000Z');
  });

  it('does not turn a selection-message reaction into acceptance', async () => {
    const trip = await loadDemoTrip('tests/fixtures/trip.json');
    const { conversation } = await createChatAdapter(trip.enrollment, 'America/New_York', 'mock', {});
    const message = { eventId: 'reaction', messageId: 'reaction', senderId: 'mason', spaceId: trip.enrollment.groupSpaceId, visibility: 'group' as const, occurredAt: '2026-10-10T16:00:00Z', reaction: { targetMessageId: 'option-message', emoji: 'like' } };
    const context = { tripId: trip.state.tripId, revision: 2, status: 'awaiting_acceptance' as const, actionable: [{ candidateId: 'plan', revision: 2, title: 'Plan', actions: ['accept' as const] }], targetProposal: { candidateId: 'plan', revision: 2, kind: 'select' as const } };
    expect((await conversation.parseInbound(message, context)).kind).toBe('ignored');
    const accepted = await conversation.parseInbound(message, { ...context, targetProposal: { candidateId: 'plan', revision: 2, kind: 'accept' } });
    expect(accepted.kind).toBe('command');
    if (accepted.kind === 'command') expect(accepted.command.action.kind).toBe('accept_candidate');
  });

  it('rejects stale cost confirmation and reprices a confirmed unknown with renewed acceptance', async () => {
    const fixture = await loadDemoTrip('tests/fixtures/trip.json');
    const planner = createPlannerAdapter(createResearchProvider({ mode: 'mock', fixtures: defaultFixtures }), fixture.enrollment.groupSpaceId);
    fixture.state.groupConstraints = fixture.state.groupConstraints.map(r => r.field === 'region' ? { ...r, value: { label: 'NC mountains', maxTravelMinutes: 240 } } : r);
    const outcome = await planner.research!(fixture.state);
    const state = planner.install!(fixture.state, outcome.revision, outcome.candidates).state;
    const candidate = state.candidates.find(c => c.costs.some(i => i.priceStatus === 'unknown'))!;
    const cost = candidate.costs.find(i => i.priceStatus === 'unknown')!;
    const command = { commandId: 'manual-price', eventId: 'cost-event', actorId: 'mason', tripId: state.tripId,
      action: { kind: 'confirm_cost' as const, candidateId: candidate.candidateId, revision: state.revision, costId: cost.costId, lowCents: 9000, highCents: 12000, sourceMessageId: 'cost-message' } };
    const stale = planner.applyCommand(state, { ...command, action: { ...command.action, revision: state.revision - 1 } }, { now: '2026-10-10T16:00:00Z' });
    expect(stale.state).toBe(state);
    expect(stale.rejection?.code).toBe('STALE_REVISION');
    const applied = planner.applyCommand(state, command, { now: '2026-10-10T16:00:00Z' });
    expect(applied.state.revision).toBe(state.revision + 1);
    expect(applied.state.acceptances).toEqual([]);
    const repriced = toPlanningState(applied.state).candidates.find(c => c.candidateId === candidate.candidateId)!;
    expect(repriced.feasibility.unknownEssentials).not.toContain(cost.label);
    expect(repriced.evidence.at(-1)?.title).toBe('Participant-confirmed estimate');
  });
});
