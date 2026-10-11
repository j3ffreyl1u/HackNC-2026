import { expect, it, vi } from 'vitest';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { approved } from './fixture.js';
import { createFundService, tripPeriod } from '../../src/funding/service.js';
import type { Purchase } from '../../src/planning/funding.js';

const M = 'mason', A = 'alex', J = 'jordan';
const buy = (memberId: string, amountDollars: number, category: string, extra: Partial<Purchase> = {}): Purchase => ({ id: `${memberId}-${category}-${amountDollars}`, memberId, amountDollars, category, status: 'completed', ...extra });

it('caches and coalesces successful reads for 30 seconds but never substitutes expired data on failure', async () => {
  const state = await approved();
  let time = 0;
  const read = vi.fn(async () => ({ purchases: [] }));
  const service = createFundService({ read }, 'mock', { now: () => time });
  await Promise.all([service.inspect(state), service.inspect(state)]);
  await service.publicView(state);
  expect(read).toHaveBeenCalledTimes(1);
  time = 30_001;
  read.mockRejectedValueOnce(new Error('Unavailable'));
  await expect(service.inspect(state)).rejects.toThrow('Unavailable');
  await service.inspect(state);
  expect(read).toHaveBeenCalledTimes(3);
});

it('works out who covered what from several friends\' purchases, and who owes whom', async () => {
  const state = await approved();
  const service = createFundService({ read: async () => ({ purchases: [buy(M, 120, 'hotel'), buy(A, 60, 'gas'), buy(J, 0 + 30, 'parks')] }) }, 'mock', { cacheMs: 0 });
  const view = await service.publicView(state) as any;
  expect(view.status).toBe('tracking');
  expect(view.sharedSpentDollars).toBe(210);
  expect(view.members.map((m: any) => [m.name, m.coveredDollars, m.fairShareDollars, m.netDollars])).toEqual([['Mason', 120, 70, 50], ['Alex', 60, 70, -10], ['Jordan', 30, 70, -40]]);
  expect(view.transfers).toEqual([{ from: 'Jordan', to: 'Mason', dollars: 40 }, { from: 'Alex', to: 'Mason', dollars: 10 }]);
});

it('the shared page view has first names and shared amounts only: no limits, no personal food, no ids of purchases', async () => {
  const state = await approved();
  const service = createFundService({ read: async () => ({ purchases: [buy(M, 50, 'gas'), buy(A, 77, 'restaurant')] }) }, 'mock', { cacheMs: 0 });
  const view = await service.publicView(state) as any;
  const text = JSON.stringify(view);
  expect(text).not.toMatch(/budget|\bcap\b|maxCents|personalDollars|restaurant|"id"/i);
  expect(view.sharedSpentDollars).toBe(50);   // Alex's $77 lunch is personal and not shown at all
  expect(text).not.toMatch(/\b77\b/);
});

it('is settled when everyone covered the same, and still tracking before anything is spent', async () => {
  const state = await approved();
  const even = createFundService({ read: async () => ({ purchases: [buy(M, 30, 'gas'), buy(A, 30, 'gas'), buy(J, 30, 'gas')] }) }, 'mock', { cacheMs: 0 });
  expect((await even.publicView(state) as any).status).toBe('settled');
  const none = createFundService({ read: async () => ({ purchases: [] }) }, 'mock', { cacheMs: 0 });
  expect((await none.publicView(state) as any).status).toBe('tracking');
});

it('only counts purchases from the trip period: after the plan was agreed, until a couple of days after it ends', async () => {
  const state = await approved();
  const withAgreement = { ...state, acceptances: [{ actorId: M, candidateId: state.selectedCandidateId!, revision: state.revision, acceptedAt: '2026-10-12T15:00:00Z' }, { actorId: A, candidateId: state.selectedCandidateId!, revision: state.revision, acceptedAt: '2026-10-13T09:00:00Z' }] };
  expect(tripPeriod(withAgreement)).toEqual({ from: '2026-10-13', to: '2026-11-19' });
  const service = createFundService({ read: async () => ({ purchases: [buy(M, 100, 'hotel', { date: '2026-10-13' }), buy(M, 40, 'gas', { date: '2026-11-19' }), buy(M, 999, 'hotel', { date: '2026-09-01' }), buy(M, 888, 'gas', { date: '2026-12-25' })] }) }, 'mock', { cacheMs: 0 });
  expect(((await service.publicView(withAgreement)) as any).sharedSpentDollars).toBe(140);
});

it('does not read the ledger for an unapproved plan, and says why', async () => {
  const { state } = await loadDemoTrip('tests/fixtures/trip.json');
  const read = vi.fn(async () => ({ purchases: [] }));
  const view = await createFundService({ read }, 'nessie').publicView(state) as any;
  expect(view.status).toBe('not_ready'); expect(view.reason).toMatch(/approved/i);
  expect(read).not.toHaveBeenCalled();
});
