import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { HouseholdConfig } from '../src/contracts/index.js';
import { createFinanceService } from '../src/finance/index.js';
import { MockBank } from '../src/finance/mock-bank.js';
import { LedgerStore } from '../src/finance/store.js';

async function removeIfPresent(file: string): Promise<void> {
  try { await unlink(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function main(): Promise<void> {
  const bankMode = process.env.BANK_MODE ?? 'mock';
  if (bankMode !== 'mock') throw new Error('Seed supports BANK_MODE=mock only in this build.');
  const databasePath = resolve(process.env.DATABASE_PATH ?? 'data/splitbot.sqlite');
  if (process.argv.includes('--reset')) {
    const localData = resolve('data');
    const rel = relative(localData, databasePath);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('--reset is limited to a database file inside the local data/ directory.');
    }
    await removeIfPresent(databasePath);
    await removeIfPresent(`${databasePath}-wal`);
    await removeIfPresent(`${databasePath}-shm`);
  }
  const household = JSON.parse(await readFile(process.env.HOUSEHOLD_CONFIG_PATH ?? 'tests/fixtures/household.json', 'utf8')) as HouseholdConfig;
  await mkdir(dirname(databasePath), { recursive: true });
  const finance = createFinanceService({
    store: LedgerStore.open(databasePath), bank: new MockBank(),
    clock: { now: () => new Date() }, newId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
  });
  try {
    await finance.bootstrapHousehold(household);
    const seeded = await finance.seedDemoBanking(household);
    await finance.bootstrapHousehold(seeded);
    console.log(`Seeded mock household ${seeded.householdId} at ${databasePath}.`);
  } finally { await finance.close(); }
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
