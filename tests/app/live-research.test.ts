import { describe, expect, it, vi } from 'vitest';
import { LiveResearchDisplay, createLivePlanner, manualCandidate } from '../../src/app/live-research.js';
import { loadDemoTrip } from '../../src/app/fixture.js';

describe('live grounding display boundary', () => {
  it('renders original answer and suggestions once without retaining provider output', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ steps: [
      { type: 'model_output', content: [{ type: 'text', text: 'Original answer <script>alert(1)</script>' }] },
      { type: 'google_search_result', result: [{ search_suggestions: '<div>Original Google search suggestions</div>' }] },
    ] }) });
    const display = new LiveResearchDisplay('test-key', 'test-model', 'http://127.0.0.1:3000', fetchImpl);
    const token = display.createLink('A trip question with no private caps.').split('/').at(-1)!;
    const html = await display.render(token);
    expect(html).toContain('Original answer &lt;script&gt;');
    expect(html).toContain('<div>Original Google search suggestions</div>');
    expect(display.has(token)).toBe(false);
    await expect(display.render(token)).rejects.toThrow(/expired/);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).tools).toEqual([{ type: 'google_search' }]);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).generation_config).toEqual({ thinking_level: 'low' });
  });
  it('rejects output without suggestions', async () => {
    const display = new LiveResearchDisplay('key', 'model', 'http://127.0.0.1:3000', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Answer' }] }] }) }));
    await expect(display.render(display.createLink('question').split('/').at(-1)!)).rejects.toThrow(/complete grounded answer/);
  });
  it('requires explicit participant confirmation of every essential live worksheet price', async () => {
    const trip = await loadDemoTrip('tests/fixtures/trip.json');
    const planner = createLivePlanner(new LiveResearchDisplay('key', 'model', 'http://127.0.0.1:3000', vi.fn()), trip.enrollment.groupSpaceId);
    const candidate = manualCandidate(trip.state);
    expect(candidate.costs.every(c => c.priceStatus === 'unknown')).toBe(true);
    expect(candidate.feasibility.feasible).toBe(false);
    expect(candidate.evidence).toEqual([]);
    let state = { ...trip.state, candidates: [candidate] };
    for (const cost of candidate.costs) {
      const result = planner.applyCommand(state, { commandId: `price:${cost.costId}`, eventId: `event:${cost.costId}`, tripId: state.tripId, actorId: 'mason', action: { kind: 'confirm_cost', candidateId: candidate.candidateId, revision: state.revision, costId: cost.costId, lowCents: 1000, highCents: 2000, sourceMessageId: `message:${cost.costId}` } }, { now: '2026-10-10T16:00:00Z' });
      expect(result.rejection).toBeUndefined();
      state = result.state;
    }
    expect(state.candidates[0].feasibility.feasible).toBe(false);
    expect(state.candidates[0].feasibility.unknownEssentials).toContain('Detailed itinerary not confirmed');
    expect(state.costConfirmations).toHaveLength(6);
    expect(state.acceptances).toEqual([]);
    const confirmed = planner.applyCommand(state, { commandId: 'stop', eventId: 'stop', actorId: 'mason', tripId: state.tripId, action: { kind: 'confirm_stop', candidateId: candidate.candidateId, revision: state.revision, sourceMessageId: 'stop-message', item: { itemId: 'visit', location: 'Participant-selected park', startAt: candidate.startAt, endAt: new Date(Date.parse(candidate.startAt) + 3600000).toISOString(), tags: ['hiking'], evidenceIds: [] } } }, { now: '2026-10-10T16:00:00Z' });
    expect(confirmed.rejection).toBeUndefined();
    state = confirmed.state;
    expect(state.itineraryConfirmations).toHaveLength(1);
    expect(state.candidates[0].feasibility.unknownEssentials).not.toContain('Detailed itinerary not confirmed');
    for (const costId of ['transport', 'activities']) state = planner.applyCommand(state, { commandId: `updated:${costId}`, eventId: `updated:${costId}`, actorId: 'mason', tripId: state.tripId, action: { kind: 'confirm_cost', candidateId: candidate.candidateId, revision: state.revision, costId, lowCents: 1000, highCents: 2000, sourceMessageId: `updated:${costId}` } }).state;
    expect(state.candidates[0].feasibility.feasible).toBe(true);
  });
});
