import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FinanceService, HouseholdConfig, HouseholdSnapshot } from '../../src/contracts/index.js';
import { createAppServer } from '../../src/app/server.js';

const config: HouseholdConfig = {
  householdId: 'demo-house', groupSpaceId: 'space', designatedPayerId: 'mason', householdAccountId: 'house',
  members: [
    { userId: 'mason', displayName: 'Mason', providerUserId: 'p1', bankAccountId: 'b1' },
    { userId: 'alex', displayName: 'Alex', providerUserId: 'p2', bankAccountId: 'b2' },
    { userId: 'jordan', displayName: 'Jordan', providerUserId: 'p3', bankAccountId: 'b3' },
  ], recipients: [{ recipientId: 'electric', displayName: 'Electricity', bankAccountId: 'recipient' }],
  demoCycles: [{ cycleId: '2026-10', bills: [] }],
};
const snapshot: HouseholdSnapshot = {
  householdId: 'demo-house', cycleId: '2026-10', currency: 'USD', balanceCents: 500,
  bills: [], contributions: [], debts: [], activity: [],
};
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function start(demoMode = true) {
  const getSnapshot = vi.fn(async () => snapshot);
  const finance = { getSnapshot, advanceDemoCycle: vi.fn(async () => undefined) } as unknown as FinanceService;
  const server = createAppServer({ finance, config, demoMode });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  close = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return { base: `http://127.0.0.1:${address.port}`, finance };
}

describe('app HTTP routes', () => {
  it('projects only the public snapshot DTO, even if Finance includes extra private fields', async () => {
    const { base, finance } = await start();
    vi.mocked(finance.getSnapshot).mockResolvedValue({
      ...snapshot,
      privateBalanceCents: 12345,
      privateMessages: ['Jordan asked for help'],
      credentials: { bankAccountId: 'private-bank-id' },
    } as unknown as HouseholdSnapshot);
    expect(await (await fetch(`${base}/api/config`)).json()).toEqual({ householdId: 'demo-house', demoMode: true });
    const response = await fetch(`${base}/api/households/demo-house/snapshot`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(snapshot);
    expect(body).not.toContain('Jordan asked for help');
    expect(body).not.toContain('private-bank-id');
  });

  it('rejects malformed cycle requests and delegates valid local changes', async () => {
    const { base, finance } = await start();
    expect((await fetch(`${base}/api/demo/advance-cycle`, { method: 'POST', body: '{' })).status).toBe(400);
    expect((await fetch(`${base}/api/demo/advance-cycle`, { method: 'POST', body: JSON.stringify({ householdId: 'demo-house', cycleId: '2026-11' }) })).status).toBe(200);
    expect(finance.advanceDemoCycle).toHaveBeenCalledWith('demo-house', '2026-11');
  });

  it('keeps demo controls disabled outside demo mode and hides unknown households', async () => {
    const { base } = await start(false);
    expect((await fetch(`${base}/api/demo/advance-cycle`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/api/households/other/snapshot`)).status).toBe(404);
  });
});
