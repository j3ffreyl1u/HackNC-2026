import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approved } from './fixture.js';
import { createBoundFundService } from '../../src/funding/bound-service.js';
import { depositTag } from '../../src/planning/funding.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'bound-')); dirs.push(dir);
  const state = await approved();
  const requests: string[] = [];
  const deposits: unknown[] = [];
  const purchases: unknown[] = [];
  const fetcher = (async (url: URL | string) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    return new Response(JSON.stringify(path.endsWith('/deposits') ? deposits : purchases), { status: 200 });
  }) as unknown as typeof fetch;
  const service = createBoundFundService({ bindingPath: join(dir, 'binding.json'), merchantsPath: join(dir, 'merchants.json'), baseUrl: 'https://nessie.example/', apiKey: 'k', cacheMs: 0, fetcher });
  const bind = (revision: number) => writeFile(join(dir, 'binding.json'), JSON.stringify({ simulated: true, accountId: 'acct-1', revision }));
  return { state, service, requests, deposits, purchases, bind, dir };
}

describe('bound fund service', () => {
  it('says the account is not set up yet, and reads nothing from Nessie', async () => {
    const t = await setup();
    const report = await t.service.inspect(t.state);
    expect(report.status).toBe('not_ready');
    expect((report as { reason?: string }).reason).toMatch(/not set up/);
    expect(t.requests).toEqual([]);
  });

  it('picks up an account that is set up while the app is running, with no restart', async () => {
    const t = await setup();
    expect((await t.service.inspect(t.state)).status).toBe('not_ready');
    await t.bind(t.state.revision);
    t.deposits.push({ _id: 'd1', amount: 45, status: 'completed', description: depositTag('mason', t.state.revision), merchant_id: undefined });
    const report: any = await t.service.inspect(t.state);
    expect(report.funding.collectedDollars).toBe(45);
    expect(t.requests.some((p) => p.includes('/accounts/acct-1/deposits'))).toBe(true);
  });

  it('shows a payment added later', async () => {
    const t = await setup();
    await t.bind(t.state.revision);
    expect(((await t.service.inspect(t.state)) as any).funding.collectedDollars).toBe(0);
    t.deposits.push({ _id: 'd2', amount: 45, status: 'completed', description: depositTag('alex', t.state.revision) });
    expect(((await t.service.inspect(t.state)) as any).funding.collectedDollars).toBe(45);
  });

  it('refuses an account that belongs to an older version of the plan', async () => {
    const t = await setup();
    await t.bind(t.state.revision + 5);
    const report = await t.service.inspect(t.state);
    expect(report.status).toBe('not_ready');
    expect(t.requests).toEqual([]);
  });

  it('the public view carries no member names or amounts per person', async () => {
    const t = await setup();
    await t.bind(t.state.revision);
    t.deposits.push({ _id: 'd3', amount: 45, status: 'completed', description: depositTag('mason', t.state.revision) });
    const view = JSON.stringify(await t.service.publicView(t.state));
    expect(view).not.toMatch(/mason|alex|jordan/i);
  });
});
