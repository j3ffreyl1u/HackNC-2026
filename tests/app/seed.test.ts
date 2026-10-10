import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFinanceService } from '../../src/finance/index.js';
import { MockBank } from '../../src/finance/mock-bank.js';
import { LedgerStore } from '../../src/finance/store.js';

const root = process.cwd();
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const seedScript = resolve('scripts/seed.ts');
const scratchDatabases: string[] = [];
const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDatabases.splice(0).map(async (file) => {
    await Promise.all([file, `${file}-wal`, `${file}-shm`].map((path) => rm(path, { force: true })));
  }));
  await Promise.all(scratchDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function runSeed(databasePath: string, reset = false, bankMode: 'mock' | 'nessie' = 'mock') {
  return spawnSync(process.execPath, [tsxCli, seedScript, ...(reset ? ['--reset'] : [])], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      BANK_MODE: bankMode,
      HOUSEHOLD_CONFIG_PATH: 'tests/fixtures/household.json',
      DATABASE_PATH: databasePath,
    },
  });
}

function seedMapping(databasePath: string): Record<string, string | null> {
  const store = LedgerStore.open(databasePath);
  try {
    return Object.fromEntries(['member-mason', 'member-alex', 'member-jordan', 'household', 'recipient-electric']
      .map((label) => [label, store.getMeta('demo-house', `seed_account:${label}`)]));
  } finally {
    store.close();
  }
}

describe('seed CLI', () => {
  it('reuses saved account IDs on repeat runs and reset creates a fresh ledger', async () => {
    await mkdir(resolve('data'), { recursive: true });
    const databasePath = resolve('data', `seed-test-${crypto.randomUUID()}.sqlite`);
    scratchDatabases.push(databasePath);

    const first = runSeed(databasePath);
    expect(first.status, first.stderr).toBe(0);
    const firstMapping = seedMapping(databasePath);
    expect(Object.values(firstMapping).every(Boolean)).toBe(true);

    const second = runSeed(databasePath);
    expect(second.status, second.stderr).toBe(0);
    expect(seedMapping(databasePath)).toEqual(firstMapping);

    const seededFinance = createFinanceService({
      store: LedgerStore.open(databasePath), bank: new MockBank(),
      clock: { now: () => new Date('2026-10-01T00:00:00.000Z') }, newId: (prefix) => `${prefix}-snapshot-test`,
    });
    try {
      const snapshot = await seededFinance.getSnapshot('demo-house');
      expect(snapshot.bills).toHaveLength(1);
      expect(snapshot.bills[0]).toMatchObject({ title: 'Electricity', amountCents: 14_400, status: 'collecting' });
    } finally {
      await seededFinance.close();
    }

    const store = LedgerStore.open(databasePath);
    store.setMeta('demo-house', 'reset-sentinel', 'old ledger');
    store.close();
    const reset = runSeed(databasePath, true);
    expect(reset.status, reset.stderr).toBe(0);
    const freshStore = LedgerStore.open(databasePath);
    try {
      expect(freshStore.getMeta('demo-house', 'reset-sentinel')).toBeNull();
      expect(freshStore.getMeta('demo-house', 'seed_account:household')).toBe(firstMapping.household);
    } finally {
      freshStore.close();
    }
  }, 45_000);

  it('refuses reset outside data and leaves the target file intact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbot-seed-guard-'));
    scratchDirectories.push(directory);
    const protectedFile = join(directory, 'keep.sqlite');
    await writeFile(protectedFile, 'preserve this file', 'utf8');

    const result = runSeed(protectedFile, true);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--reset is limited');
    expect(await readFile(protectedFile, 'utf8')).toBe('preserve this file');
  });

  it('refuses reset in Nessie mode before touching the configured database', async () => {
    await mkdir(resolve('data'), { recursive: true });
    const databasePath = resolve('data', `nessie-reset-guard-${crypto.randomUUID()}.sqlite`);
    scratchDatabases.push(databasePath);
    await writeFile(databasePath, 'live ledger sentinel', 'utf8');

    const result = runSeed(databasePath, true, 'nessie');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--reset is mock-only');
    expect(await readFile(databasePath, 'utf8')).toBe('live ledger sentinel');
  });
});
