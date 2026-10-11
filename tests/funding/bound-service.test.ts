import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approved } from './fixture.js';
import { createBoundFundService } from '../../src/funding/bound-service.js';
import { depositTag } from '../../src/planning/funding.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

/** A fake Nessie sandbox: creating objects hands out ids, and reads return whatever the test has put in the ledger. */
async function setup(options: { failCreate?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bound-')); dirs.push(dir);
  const state = await approved();
  const calls: Array<{ method: string; path: string }> = [];
  const deposits: unknown[] = [];
  const purchases: unknown[] = [];
  let created = 0;
  const fetcher = (async (url: URL | string, init?: { method?: string }) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    if (method === 'POST') {
      if (options.failCreate) return new Response('no', { status: 500 });
      if (path.endsWith('/deposits')) return new Response(JSON.stringify({ objectCreated: { _id: 'dep-new' } }), { status: 201 });
      created += 1;
      return new Response(JSON.stringify({ objectCreated: { _id: path.endsWith('/accounts') ? `acct-${created}` : `cust-${created}` } }), { status: 201 });
    }
    return new Response(JSON.stringify(path.endsWith('/deposits') ? deposits : purchases), { status: 200 });
  }) as unknown as typeof fetch;
  const bindingPath = join(dir, 'binding.json');
  const service = createBoundFundService({ bindingPath, merchantsPath: join(dir, 'merchants.json'), baseUrl: 'https://nessie.example/', apiKey: 'k', cacheMs: 0, fetcher });
  const posts = () => calls.filter((c) => c.method === 'POST').map((c) => c.path.split('/').slice(-1)[0]);
  const binding = async () => JSON.parse(await readFile(bindingPath, 'utf8')) as { accountId: string; revision: number };
  return { state, service, calls, deposits, posts, binding, bindingPath, dir };
}

describe('bound fund service', () => {
  it('makes the sandbox account itself the first time an approved plan asks about the fund', async () => {
    const t = await setup();
    const report: any = await t.service.inspect(t.state);
    expect(t.posts()).toEqual(['customers', 'accounts']);
    expect((await t.binding()).revision).toBe(t.state.revision);
    expect(report.funding.collectedDollars).toBe(0);
  });

  it('does not make an account while nothing is approved, and reads nothing', async () => {
    const t = await setup();
    const report: any = await t.service.inspect({ ...t.state, status: 'gathering' });
    expect(report.status).toBe('not_ready');
    expect(t.calls).toEqual([]);
  });

  it('makes only one account per approved revision, even when asked twice at once', async () => {
    const t = await setup();
    await Promise.all([t.service.inspect(t.state), t.service.inspect(t.state), t.service.publicView(t.state)]);
    await t.service.inspect(t.state);
    expect(t.posts()).toEqual(['customers', 'accounts']);
  });

  it('makes a fresh account when the approved plan has a new revision', async () => {
    const t = await setup();
    await writeFile(t.bindingPath, JSON.stringify({ simulated: true, accountId: 'old-account', revision: t.state.revision + 5 }));
    await t.service.inspect(t.state);
    expect(t.posts()).toEqual(['customers', 'accounts']);
    expect((await t.binding()).accountId).not.toBe('old-account');
    expect((await t.binding()).revision).toBe(t.state.revision);
  });

  it('shows a payment that was added later', async () => {
    const t = await setup();
    expect(((await t.service.inspect(t.state)) as any).funding.collectedDollars).toBe(0);
    t.deposits.push({ _id: 'd2', amount: 45, status: 'completed', description: depositTag('alex', t.state.revision) });
    expect(((await t.service.inspect(t.state)) as any).funding.collectedDollars).toBe(45);
  });

  it('forget() drops the account, and the next approved plan gets a new one', async () => {
    const t = await setup();
    await t.service.inspect(t.state);
    await t.service.forget!();
    await expect(stat(t.bindingPath)).rejects.toThrow();
    await t.service.inspect(t.state);
    expect(t.posts()).toEqual(['customers', 'accounts', 'customers', 'accounts']);
  });

  it('says plainly when the sandbox will not make an account, and does not crash', async () => {
    const t = await setup({ failCreate: true });
    const report: any = await t.service.inspect(t.state);
    expect(report.status).toBe('not_ready');
    expect(report.reason).toMatch(/couldn't set up the sandbox fund account/);
  });

  it('a deposit goes to the account for the approved revision, tagged with the person', async () => {
    const t = await setup();
    await t.service.inspect(t.state);
    await t.service.deposit!('mason', 45, t.state.revision);
    expect(t.posts().at(-1)).toBe('deposits');
    await expect(t.service.deposit!('mason', 45, t.state.revision + 1)).rejects.toThrow(/not set up for this plan/);
  });

  it('the public view carries no member names or amounts per person', async () => {
    const t = await setup();
    t.deposits.push({ _id: 'd3', amount: 45, status: 'completed', description: depositTag('mason', t.state.revision) });
    const view = JSON.stringify(await t.service.publicView(t.state));
    expect(view).not.toMatch(/mason|alex|jordan/i);
  });
});
