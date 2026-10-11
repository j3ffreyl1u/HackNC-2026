import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { runMockDemo } from '../../src/app/mock-demo.js';
import { createPlannerAdapter, toPlanningState } from '../../src/app/planning-adapter.js';
import { localMidnight, createChatAdapter, convert } from '../../src/app/conversation-adapter.js';
import { createResearchProvider } from '../../src/research/provider.js';
import { defaultFixtures } from '../../src/research/fixtures.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';
import { resolveGroupField } from '../../src/planning/constraints.js';

describe('integrated chat planner', () => {
  it('exercises the $520/$560/$600 preset, keeps $328 and excludes $500 after a $450 revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realistic-demo-'));
    const repository = SqliteTripRepository.open(join(dir, 'trip.sqlite'));
    try {
      const trip = await loadDemoTrip('tests/fixtures/realistic-demo.json');
      expect(trip.state.memberConstraints.filter(r => r.field === 'budget').map(r => r.value)).toEqual([52000, 56000, 60000]);
      const result = await runMockDemo(repository, trip.enrollment, trip.state, { realistic: true });
      expect(result.totals).toEqual([32800, 50000]);
      expect(result.state.memberConstraints.filter(r => r.memberId === 'mason' && r.field === 'budget').at(-1)?.value).toBe(45000);
      expect(result.state.status).toBe('approved');
      expect(result.state.candidates.filter(c => c.feasibility.feasible).map(c => c.perPersonTotals[0].highCents)).toEqual([32800]);
    } finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('intercepts cost text before A and uses explicit B question fields', async () => {
    const trip = await loadDemoTrip('tests/fixtures/trip.json');
    const { conversation } = await createChatAdapter(trip.enrollment, 'America/New_York', 'mock', {});
    const parsed = await conversation.parseInbound({ eventId: 'cost', messageId: 'cost-message', senderId: 'mason', spaceId: trip.enrollment.groupSpaceId, visibility: 'group', occurredAt: '2026-10-10T16:00:00Z', text: 'confirm cost manual-1 v1 lodging $240-$300' }, { tripId: trip.state.tripId, revision: 1, status: 'gathering', actionable: [] });
    expect(parsed.kind).toBe('command');
    if (parsed.kind === 'command') expect(parsed.command.action).toMatchObject({ kind: 'confirm_cost', lowCents: 24000, highCents: 30000 });
    trip.state.groupConstraints = [];
    const planner = createPlannerAdapter(createResearchProvider({ mode: 'mock', fixtures: defaultFixtures }), trip.enrollment.groupSpaceId);
    const result = planner.applyCommand(trip.state, { commandId: 'plans', eventId: 'plans', actorId: 'mason', tripId: trip.state.tripId, action: { kind: 'request_plans' } }, { now: '2026-10-10T16:00:00Z' });
    expect(result.state.pendingQuestions.map(q => q.field).sort()).toEqual(['origin']);
  });
  it('supports a direct-mode shared broadcast through individual DM receipts', async () => {
    const trip = await loadDemoTrip('tests/fixtures/trip.json');
    const { conversation } = await createChatAdapter({ ...trip.enrollment, mode: 'direct' }, 'America/New_York', 'mock', {});
    const receipts = await conversation.sendMessage({ deliveryId: 'broadcast', audience: { kind: 'group', spaceId: trip.enrollment.groupSpaceId }, text: 'Plan version 1' });
    expect(receipts).toHaveLength(3);
    expect(new Set(receipts.map(r => r.providerMessageId)).size).toBe(3);
  });
  it('keeps conflicting group positions attributed to their original members', async () => {
    const trip = await loadDemoTrip('tests/fixtures/trip.json');
    const planner = createPlannerAdapter(createResearchProvider({ mode: 'mock', fixtures: defaultFixtures }), trip.enrollment.groupSpaceId);
    const result = planner.applyCommand(trip.state, { commandId: 'origin', eventId: 'origin', actorId: 'alex', tripId: trip.state.tripId, action: { kind: 'update_constraint', update: { memberId: 'alex', field: 'origin', value: 'Durham', sourceMessageId: 'alex-origin', certainty: 'confirmed' } } }, { now: '2026-10-10T16:00:00Z' });
    expect(result.state.groupConstraints.filter(r => r.field === 'origin').map(r => r.memberId).sort()).toEqual(['alex', 'mason']);
    expect(resolveGroupField(toPlanningState(result.state), 'origin').status).toBe('conflict');
  });
  it('normalizes inclusive dates across DST once and preserves already-normalized intervals', () => {
    const base = { commandId: 'dates', eventId: 'dates', actorId: 'alex', tripId: 'trip' };
    const command = convert({ ...base, action: { kind: 'update_constraint', update: { memberId: 'alex', field: 'availability', value: [{ start: '2026-11-01', end: '2026-11-01' }], sourceMessageId: 'dates', certainty: 'confirmed' } } }, 'America/New_York');
    if (command.action.kind === 'update_constraint') expect(command.action.update.value).toEqual([{ startAt: '2026-11-01T04:00:00.000Z', endAt: '2026-11-02T05:00:00.000Z', timeZone: 'America/New_York' }]);
    expect(convert(command, 'America/New_York')).toEqual(command);
  });
  it('preserves A explicit drive limits and vehicle availability without inventing a limit', () => {
    const base = { commandId: 'cmd', eventId: 'evt', actorId: 'alex', tripId: 'trip' };
    const source = { memberId: 'alex', sourceMessageId: 'message', certainty: 'confirmed' as const };
    const region = convert({ ...base, action: { kind: 'update_constraint', update: { ...source, field: 'region', value: 'NC mountains', maxTravelMinutes: 90 } } }, 'America/New_York');
    if (region.action.kind === 'update_constraint') expect(region.action.update).toMatchObject({ value: 'NC mountains', maxTravelMinutes: 90 });
    const unbounded = convert({ ...base, action: { kind: 'update_constraint', update: { ...source, field: 'region', value: 'NC mountains' } } }, 'America/New_York');
    if (unbounded.action.kind === 'update_constraint') { expect(unbounded.action.update.value).toBe('NC mountains'); expect(unbounded.action.update).not.toHaveProperty('maxTravelMinutes'); }
    const transport = convert({ ...base, action: { kind: 'update_constraint', update: { ...source, field: 'transport', value: 'own_vehicle', vehicleAvailable: false } } }, 'America/New_York');
    if (transport.action.kind === 'update_constraint') expect(transport.action.update).toMatchObject({ value: 'own_vehicle', vehicleAvailable: false });
  });
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
    expect(repriced.evidence.some(e => e.url === '')).toBe(false);
    expect(applied.state.costConfirmations?.at(-1)?.sourceMessageId).toBe('cost-message');
  });
});
