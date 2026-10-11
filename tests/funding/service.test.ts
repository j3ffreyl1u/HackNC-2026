import { expect, it, vi } from 'vitest';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { approved } from './fixture.js';
import { createFundService } from '../../src/funding/service.js';
import { depositTag } from '../../src/planning/funding.js';

it('caches and coalesces successful reads for 30 seconds but never substitutes expired data on failure', async () => {
  const state = await approved();
  let time = 0;
  const read = vi.fn(async () => ({ deposits: [], purchases: [] }));
  const service = createFundService({ read }, 'mock', undefined, { now: () => time });
  await Promise.all([service.inspect(state), service.inspect(state)]);
  await service.publicView(state);
  expect(read).toHaveBeenCalledTimes(1);
  time = 30_001;
  read.mockRejectedValueOnce(new Error('Unavailable'));
  await expect(service.inspect(state)).rejects.toThrow('Unavailable');
  await service.inspect(state);
  expect(read).toHaveBeenCalledTimes(3);
});

it('shows funded only when every current-revision participant covers their own contribution', async () => {
  const state = await approved();
  let deposits: Array<{ id: string; amountDollars: number; description: string; status: string }> = [];
  const service = createFundService({ read: async () => ({ deposits, purchases: [] }) }, 'mock', undefined, { cacheMs: 0 });
  const before = await service.inspect(state);
  if (!before.plan) throw new Error('Expected approved contribution plan');
  deposits = before.plan.requests.map((r, index) => ({ id: `d${index}`, amountDollars: r.dollars, description: depositTag(r.memberId, state.revision), status: 'completed' }));
  const view = await service.publicView(state);
  expect(view.status).toBe('funded');
  expect(JSON.stringify(view)).not.toMatch(/memberId|perMember|description|requests|budgetCap/);
  deposits[0].status = 'pending';
  expect((await service.publicView(state)).status).toBe('partially_funded');
});
it('does not read the ledger for unapproved or mismatched-revision plans', async () => {
  const { state } = await loadDemoTrip('tests/fixtures/trip.json');
  const read = vi.fn(async () => ({ deposits: [], purchases: [] }));
  const service = createFundService({ read }, 'nessie', 99);
  expect((await service.publicView(state)).status).toBe('not_ready');
  expect((await service.publicView(await approved())).status).toBe('not_ready');
  expect(read).not.toHaveBeenCalled();
});
