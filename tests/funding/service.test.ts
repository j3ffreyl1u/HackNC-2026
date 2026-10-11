import { expect, it, vi } from 'vitest';
import { loadDemoTrip } from '../../src/app/fixture.js';
import { approved } from './fixture.js';
import { createFundService } from '../../src/funding/service.js';
import { depositTag } from '../../src/planning/funding.js';

it('shows funded only when every current-revision participant covers their own contribution', async () => {
  const state = await approved();
  let deposits: Array<{ id: string; amountDollars: number; description: string; status: string }> = [];
  const service = createFundService({ read: async () => ({ deposits, purchases: [] }) }, 'mock');
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
