import { describe, expect, it, vi } from 'vitest';
import { applyCommand, installCandidates } from '../../src/planning/commands.js';
import { PlanningError, generateCandidates, planTrip } from '../../src/planning/generate.js';
import { createTrip } from '../../src/planning/state.js';
import { createFixtureProvider, createResearchProvider } from '../../src/research/provider.js';
import { defaultFixtures } from '../../src/research/fixtures.js';
import { ResearchError, type ResearchProvider, type ResearchRequest } from '../../src/research/types.js';
import { NOW, command, ids, put, readyState, roster } from './fixtures.js';

const provider = createFixtureProvider(defaultFixtures, () => NOW);
const groupText = (r: { replies: { audience: { kind: string }; text: string }[] }) => r.replies.filter((x) => x.audience.kind === 'group').map((x) => x.text).join('\n');

describe('planTrip: the acceptance fixture', () => {
  it('proposes two feasible options at 18,000 and 19,000 per person, best first, plus a provisional one', async () => {
    const outcome = await planTrip(readyState(), provider);
    const [first, second, third] = outcome.candidates;
    expect(outcome.candidates).toHaveLength(3);
    expect([first.title, second.title]).toEqual(['State park and small-town weekend', 'Mountain cabin weekend']);
    expect(first.perPersonTotals.map((t) => t.highCents)).toEqual([18_000, 18_000, 18_000]);
    expect(second.perPersonTotals.map((t) => t.highCents)).toEqual([19_000, 19_000, 19_000]);
    expect(first.feasibility.feasible && second.feasibility.feasible).toBe(true);
    // The third has an unknown lodging price: shown, but never feasible.
    expect(third.title).toBe('City and brewery weekend');
    expect(third.feasibility).toMatchObject({ feasible: false, violations: [], unknownEssentials: ['asheville:lodging'] });
  });

  it('stamps the revision, the fixture label and unique IDs on every candidate', async () => {
    const outcome = await planTrip(readyState(), provider);
    expect(outcome.revision).toBe(1);
    expect(outcome.mode).toBe('fixture');
    for (const c of outcome.candidates) {
      expect(c.revision).toBe(1);
      expect(c.dataSource).toBe('fixture');
      expect(c.candidateId).toMatch(/^trip-1-r1-/);
      expect(c.tradeoffs.join(' ')).toMatch(/Fixture data/);
      expect(c.tradeoffs.join(' ')).toMatch(/Availability and current prices have not been checked/);
    }
    expect(new Set(outcome.candidates.map((c) => c.candidateId)).size).toBe(3);
  });

  it('totals add up exactly: shared + personal + contingency', async () => {
    const [c] = await generateCandidates(readyState(), provider);
    const sum = c.perPersonTotals.reduce((n, t) => n + t.highCents, 0);
    const costs = c.costs.reduce((n, x) => n + x.highCents, 0);
    expect(sum).toBe(costs + c.contingencyCents);
    expect(c.contingencyCents).toBe(3_000);
  });

  it('personal costs are expanded per participant and shared costs are not', async () => {
    const [c] = await generateCandidates(readyState(), provider);
    expect(c.costs.filter((x) => x.allocation === 'personal').map((x) => x.memberId)).toEqual(ids);
    expect(c.costs.filter((x) => x.allocation === 'equal_shared').every((x) => x.memberId === undefined)).toBe(true);
  });

  it('the trip sits inside everyone’s window and the itinerary inside the trip', async () => {
    const [c] = await generateCandidates(readyState(), provider);
    expect(c.startAt).toBe('2026-10-16T17:00:00.000Z');
    expect(c.endAt).toBe('2026-10-18T17:00:00.000Z');
    for (const item of c.itinerary) {
      expect(item.startAt >= c.startAt && item.endAt <= c.endAt).toBe(true);
    }
  });

  it('lays the itinerary out on real days in the trip’s local time: nothing before 9 am or after 8 pm', async () => {
    const { localHour } = await import('../../src/planning/schedule.js');
    for (const c of await generateCandidates(readyState(), provider)) {
      expect(c.itinerary.length).toBeGreaterThan(1);
      for (const item of c.itinerary) {
        expect(localHour(Date.parse(item.startAt), 'America/New_York')).toBeGreaterThanOrEqual(9);
        expect(localHour(Date.parse(item.endAt), 'America/New_York')).toBeLessThanOrEqual(20);
      }
      // The trip is two days: something happens on Saturday, not only Friday night.
      expect(c.itinerary.some((i) => i.startAt.slice(0, 10) === '2026-10-17')).toBe(true);
    }
  });

  it('honors a different time zone, and rejects an unknown one', async () => {
    const { localHour } = await import('../../src/planning/schedule.js');
    const [c] = await generateCandidates(readyState(), provider, { timeZone: 'America/Chicago' });
    for (const item of c.itinerary) expect(localHour(Date.parse(item.startAt), 'America/Chicago')).toBeGreaterThanOrEqual(9);
    await expect(planTrip(readyState(), provider, { timeZone: 'Mars/Olympus' })).rejects.toBeInstanceOf(PlanningError);
  });

  it('evidence links survive generation and every citation resolves', async () => {
    for (const c of await generateCandidates(readyState(), provider)) {
      const known = new Set(c.evidence.map((e) => e.evidenceId));
      expect(c.evidence.length).toBeGreaterThan(0);
      for (const e of c.evidence) expect(e.url).toMatch(/^https:\/\/fixtures\.invalid\//);
      for (const id of [...c.itinerary.flatMap((i) => i.evidenceIds), ...c.costs.flatMap((x) => x.evidenceIds)]) expect(known.has(id)).toBe(true);
    }
  });

  it('the chat messages are short: two options tied to the exact revision, one link to the full plan, and the demo label', async () => {
    const outcome = await planTrip(readyState(), provider);
    const proposals = outcome.replies.filter((r) => r.proposalRef);
    expect(proposals.map((r) => r.proposalRef?.revision)).toEqual([1, 1]);
    const text = groupText(outcome);
    expect(text).toContain('{{PLAN_LINK}}');              // sources, itinerary and costs live on the trip page
    expect(text).not.toContain('https://fixtures.invalid/');
    expect(text).toMatch(/About \$\d+ each, up to \$\d+ at the high end \(hotel \$\d+/);
    expect(text).toMatch(/demo data/i);
    expect(text).toMatch(/couldn't price it well enough to propose it/);   // the option with incomplete prices is flagged as a maybe, not proposed
    for (const reply of outcome.replies) expect(reply.text.length).toBeLessThan(420);
  });

  it('the chat messages never contain a private cap', async () => {
    const text = groupText(await planTrip(readyState(), provider));
    for (const cap of ['200.00', '250.00', '300.00', '20,000', '25,000', '30,000']) expect(text).not.toContain(cap);
  });
});

describe('planTrip: hard limits filter', () => {
  it('lowering one cap to 18,000 excludes the 19,000 option and keeps the 18,000 one', async () => {
    const outcome = await planTrip(readyState({ mason: 18_000, alex: 25_000, jordan: 30_000 }), provider);
    expect(outcome.candidates.filter((c) => c.feasibility.feasible).map((c) => c.title)).toEqual(['State park and small-town weekend']);
    expect(outcome.excluded.map((c) => c.title)).toEqual(['Mountain cabin weekend']);
    expect(groupText(outcome)).toContain('found a trip that fit');
  });

  it('an option that fits only if the group’s caps are summed is still rejected', async () => {
    // 75,000 combined would cover 54,000 of cost per person, yet Mason alone can't afford 18,000+.
    const outcome = await planTrip(readyState({ mason: 17_000, alex: 100_000, jordan: 100_000 }), provider);
    expect(outcome.candidates.some((c) => c.feasibility.feasible)).toBe(false);
  });

  it('explains the conflict, asks for consent to relax, and states no amount publicly', async () => {
    const outcome = await planTrip(readyState({ mason: 5_000, alex: 5_000, jordan: 5_000 }), provider);
    expect(outcome.candidates.every((c) => !c.feasibility.feasible)).toBe(true);
    const text = groupText(outcome);
    expect(text).toMatch(/couldn't find a 2-night trip .*that works for everyone/);
    expect(text).toMatch(/A few ways to fix it/);
    expect(text).toMatch(/never change anyone's limit unless they say so/);
    expect(text).not.toMatch(/\$\d|5,?000/);
  });

  it('tells each person who would have to stretch their own overage, privately', async () => {
    const outcome = await planTrip(readyState({ mason: 17_000, alex: 25_000, jordan: 30_000 }), provider);
    const privates = outcome.replies.filter((r) => r.audience.kind === 'private');
    expect(privates).toHaveLength(1);
    expect(privates[0].audience).toEqual({ kind: 'private', memberId: 'mason' });
    expect(privates[0].text).toMatch(/about \$\d+\.\d\d over your max/);
    expect(privates[0].text).toMatch(/If you're okay stretching/);
  });

  it('a stated must-do that no option covers rules everything out', async () => {
    const state = put(readyState(), 'alex', 'must_dos', { items: ['waterfall'] });
    const outcome = await planTrip(state, provider);
    expect(outcome.candidates.filter((c) => c.feasibility.feasible)).toEqual([]);
    expect(groupText(outcome)).toMatch(/must-have/);
  });

  it('a drive limit shorter than any option leaves nothing, and says nothing matched', async () => {
    let state = readyState();
    for (const id of ids) state = put(state, id, 'region', { searchRegion: 'NC mountains', maxTravelMinutes: 60 });
    const outcome = await planTrip(state, provider);
    expect(outcome.candidates).toEqual([]);
    expect(groupText(outcome)).toMatch(/couldn't find anything around NC mountains that matched/);
  });

  it('stops that cannot fit in the dates are left out and said so', async () => {
    const data = structuredClone(defaultFixtures);
    const park = data.options.find((o) => o.optionId === 'hanging-rock');
    if (!park) throw new Error('fixture missing');
    park.stops[1].hours = 60;
    const hanging = (await planTrip(readyState(), createFixtureProvider(data, () => NOW))).candidates.find((x) => x.title === park.name);
    expect(hanging?.tradeoffs.join(' ')).toMatch(/Left out "Day hike"/);
    expect(hanging?.itinerary.map((i) => i.label)).not.toContain('Day hike');
  });

  it('does not show an option that has no prices at all, and says why, instead of showing $0', async () => {
    const data = structuredClone(defaultFixtures);
    const city = data.options.find((o) => o.optionId === 'asheville');
    if (!city) throw new Error('fixture missing');
    city.costs = city.costs.map((c) => ({ ...c, priceStatus: 'unknown' as const, lowCents: 0, highCents: 0, evidenceIds: [] }));
    city.perPersonCosts = city.perPersonCosts.map((c) => ({ ...c, priceStatus: 'unknown' as const, lowCents: 0, highCents: 0, evidenceIds: [] }));
    const outcome = await planTrip(readyState(), createFixtureProvider(data, () => NOW));
    expect(outcome.candidates.map((c) => c.title)).toEqual(['State park and small-town weekend', 'Mountain cabin weekend']);
    const text = groupText(outcome);
    expect(text).toMatch(/I also found City and brewery weekend, but I couldn't price it well enough to propose it/);
    expect(text).not.toMatch(/\$0\.00 to \$0\.00/);
  });

  it('says plainly when no contingency was suggested', async () => {
    const data = structuredClone(defaultFixtures);
    for (const o of data.options) delete o.suggestedContingencyPerPersonCents;
    const [c] = await generateCandidates(readyState(), createFixtureProvider(data, () => NOW));
    expect(c.contingencyCents).toBe(0);
    expect(c.tradeoffs.join(' ')).toMatch(/No contingency has been set/);
  });
});

describe('planTrip: research boundaries', () => {
  it('refuses to research an incomplete trip, and never calls the provider', async () => {
    const search = vi.fn();
    const spy: ResearchProvider = { mode: 'fixture', search };
    await expect(planTrip(createTrip('trip-1', roster), spy)).rejects.toMatchObject({ name: 'PlanningError', code: 'NOT_READY' });
    expect(search).not.toHaveBeenCalled();
  });

  it('sends the provider interests, place and dates but no money', async () => {
    const seen: ResearchRequest[] = [];
    const spy: ResearchProvider = { mode: 'fixture', search: async (r) => (seen.push(r), provider.search(r)) };
    await planTrip(readyState(), spy);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ purpose: 'plan', revision: 1, origin: 'Chapel Hill', searchRegion: 'NC mountains', maxTravelMinutes: 240, interests: ['hiking', 'town visit'] });
    expect(seen[0].window?.startAt).toBe('2026-10-16T17:00:00.000Z');
    expect(JSON.stringify(seen[0])).not.toMatch(/20000|25000|30000|budget|cents/i);
  });

  it('a live research failure surfaces as RESEARCH_UNAVAILABLE with no fixture fallback', async () => {
    const live = createResearchProvider({ mode: 'live', fixtures: defaultFixtures });
    await expect(planTrip(readyState(), live)).rejects.toBeInstanceOf(ResearchError);
    await expect(planTrip(readyState(), live)).rejects.toMatchObject({ code: 'RESEARCH_UNAVAILABLE', reason: 'not_configured' });
  });

  it('discards research that answers for a different revision', async () => {
    const stale: ResearchProvider = { mode: 'fixture', search: async (r) => provider.search({ ...r, revision: r.revision - 1 }) };
    await expect(planTrip(readyState(), stale)).rejects.toBeInstanceOf(PlanningError);
  });
});

describe('end to end with the state machine', () => {
  it('generate, install, choose, accept; then a lower cap voids it and reprices', async () => {
    let state = readyState();
    const candidates = await generateCandidates(state, provider);
    state = installCandidates(state, 1, candidates).state;
    expect(state.status).toBe('proposed');

    const cheap = candidates[0];
    const dear = candidates[1];
    state = applyCommand(state, command('mason', { kind: 'select_candidate', candidateId: dear.candidateId, revision: 1 }), { now: NOW }).state;
    for (const id of ids) state = applyCommand(state, command(id, { kind: 'accept_candidate', candidateId: dear.candidateId, revision: 1 }), { now: NOW }).state;
    expect(state.status).toBe('approved');

    state = applyCommand(state, command('mason', { kind: 'update_constraint', update: { memberId: 'mason', field: 'budget', value: { cents: 18_000 }, sourceMessageId: 'late', certainty: 'confirmed' } }), { now: NOW }).state;
    expect(state.revision).toBe(2);
    expect(state.acceptances).toEqual([]);
    expect(state.candidates.find((c) => c.candidateId === dear.candidateId)?.feasibility.feasible).toBe(false);
    expect(state.candidates.find((c) => c.candidateId === cheap.candidateId)?.feasibility.feasible).toBe(true);
  });

  it('research for the old revision cannot replace the new state', async () => {
    let state = readyState();
    const candidates = await generateCandidates(state, provider);
    state = applyCommand(state, command('mason', { kind: 'update_constraint', update: { memberId: 'mason', field: 'budget', value: { cents: 15_000 }, sourceMessageId: 'x', certainty: 'confirmed' } }), { now: NOW }).state;
    const result = installCandidates(state, 1, candidates);
    expect(result.rejection?.code).toBe('STALE_REVISION');
    expect(result.state).toBe(state);
  });
});

describe('planTrip: option messages read like a friend explaining', () => {
  const proposals = async () => (await planTrip(readyState(), provider)).replies.filter((r) => r.proposalRef).map((r) => r.text);

  it('is three short lines: what and when, where, a rough cost per person with its parts, and the drive', async () => {
    for (const [i, text] of (await proposals()).entries()) {
      const lines = text.split('\n').filter((l) => !l.startsWith('Good news'));
      expect(lines.filter(Boolean).length, text).toBeLessThanOrEqual(4);
      expect(text).toMatch(new RegExp(`Option ${i + 1}: .+, Oct 16-18\\.`));
      expect(text).toMatch(/About \$\d+ each, up to \$\d+ at the high end \(hotel \$\d+, food \$\d+, gas and parking \$\d+/);
      expect(text).toMatch(/Roughly a [\d.]+ hours? drive\./);
      expect(text).not.toContain('·');
    }
  });

  it('the total is the sum of the parts it lists', async () => {
    for (const text of await proposals()) {
      const total = Number(/About \$(\d+) each/.exec(text)?.[1]);
      const inside = /high end \((.*?)\)\./.exec(text)?.[1] ?? '';
      const parts = [...inside.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      expect(parts.length).toBeGreaterThanOrEqual(3);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('never shows a route as something to do', async () => {
    for (const text of await proposals()) expect(text).not.toMatch(/\b(?:US|I)-\d+|byway|bypass|detour/i);
  });

  it('puts everything found-but-not-proposed in one line', async () => {
    const text = groupText(await planTrip(readyState(), provider));
    expect(text.match(/I also found/g) ?? []).toHaveLength(1);
  });

  it('says a provisional option is at least that much, with some prices unknown', async () => {
    const outcome = await planTrip(readyState(), provider);
    const maybe = outcome.candidates.find((c) => !c.feasibility.feasible);
    expect(maybe).toBeDefined();
    expect(outcome.replies.map((r) => r.text).join('\n')).not.toMatch(/Maybe: City/); // maybes live on the page, not as chat proposals
  });
});

describe('planTrip: whose limit is in the way', () => {
  const privatesOf = (o: { replies: { audience: { kind: string; memberId?: string }; text: string }[] }) => o.replies.filter((r) => r.audience.kind === 'private');

  it('names the person whose limit the closest trip breaks, with no amounts, and nobody else', async () => {
    const outcome = await planTrip(readyState({ mason: 17_000, alex: 25_000, jordan: 30_000 }), provider);
    const text = groupText(outcome);
    expect(text).toMatch(/Mason/);
    expect(text).not.toMatch(/Alex|Jordan/);
    expect(text).not.toMatch(/\$\d|\d,\d{3}|17,?000|170/);
    expect(text).toMatch(/Mason, I'm sending you a private note/);
  });

  it('sends the exact amount only to that person', async () => {
    const outcome = await planTrip(readyState({ mason: 17_000, alex: 25_000, jordan: 30_000 }), provider);
    const privates = privatesOf(outcome);
    expect(privates.map((p) => p.audience.memberId)).toEqual(['mason']);
    expect(privates[0].text).toMatch(/\$\d+\.\d\d over your max/);
    for (const r of outcome.replies.filter((x) => x.audience.kind === 'group')) expect(r.text).not.toMatch(/over your max|\$10\.00/);
  });

  it('names both people when both limits are in the way, and the higher limit is not blamed', async () => {
    const outcome = await planTrip(readyState({ mason: 17_000, alex: 17_000, jordan: 30_000 }), provider);
    const text = groupText(outcome);
    expect(text).toMatch(/Mason and Alex/);
    expect(text).not.toMatch(/Jordan/);
    expect(privatesOf(outcome).map((p) => p.audience.memberId).sort()).toEqual(['alex', 'mason']);
  });
});

describe('planTrip: what the message says matches what the budget check uses', () => {
  it('the "up to" figure is the one the cap is checked against, so a shown option never exceeds anyone’s max', async () => {
    const outcome = await planTrip(readyState(), provider);
    for (const c of outcome.candidates.filter((x) => x.feasibility.feasible)) {
      const text = outcome.replies.find((r) => r.proposalRef?.candidateId === c.candidateId)!.text;
      const upTo = Number(/up to \$(\d+) at the high end/.exec(text)?.[1]);
      const worst = Math.max(...c.perPersonTotals.map((t) => t.highCents)) / 100;
      expect(Math.abs(upTo - worst)).toBeLessThanOrEqual(2.5); // rounded to the nearest $5
      expect(upTo).toBeGreaterThanOrEqual(Number(/About \$(\d+) each/.exec(text)?.[1]));
    }
  });

  it('never writes "You\'ll" in front of a bare list of places', async () => {
    for (const r of (await planTrip(readyState(), provider)).replies) expect(r.text).not.toMatch(/You'll [A-Z]/);
  });
});

describe('a change after approval that leaves people disagreeing', () => {
  it('does not tell the group to accept again while it is also asking them to settle the disagreement', async () => {
    let state = readyState();
    const candidates = await generateCandidates(state, provider);
    state = installCandidates(state, 1, candidates).state;
    const dear = candidates[1];
    state = applyCommand(state, command('mason', { kind: 'select_candidate', candidateId: dear.candidateId, revision: 1 }), { now: NOW }).state;
    for (const id of ids) state = applyCommand(state, command(id, { kind: 'accept_candidate', candidateId: dear.candidateId, revision: 1 }), { now: NOW }).state;
    expect(state.status).toBe('approved');
    const result = applyCommand(state, command('mason', { kind: 'update_constraint', update: { memberId: 'mason', field: 'duration', value: { nights: 3 }, sourceMessageId: 'late', certainty: 'confirmed' } }), { now: NOW });
    const text = result.replies.map((r) => r.text).join('\n');
    expect(text).toMatch(/Which should we go with\?/);
    expect(text).toMatch(/Earlier approvals no longer apply/);
    expect(text).not.toMatch(/Please accept/);
  });
});
