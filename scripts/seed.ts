import { mkdir, readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { HouseholdConfig } from '../src/contracts/index.js';
import { createFinanceService } from '../src/finance/index.js';
import { MockBank } from '../src/finance/mock-bank.js';
import { NessieBank } from '../src/finance/nessie.js';
import { LedgerStore } from '../src/finance/store.js';

async function removeIfPresent(file: string): Promise<void> {
  try { await unlink(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function main(): Promise<void> {
  const bankMode = process.env.BANK_MODE ?? 'mock';
  if (bankMode !== 'mock' && bankMode !== 'nessie') throw new Error(`BANK_MODE=${bankMode} is unsupported; choose mock or nessie.`);
  if (bankMode === 'nessie' && process.argv.includes('--reset')) {
    throw new Error('--reset is mock-only and can never remove a Nessie ledger.');
  }
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
  const bank = bankMode === 'mock'
    ? new MockBank()
    : new NessieBank({
      apiKey: process.env.NESSIE_API_KEY ?? '',
      baseUrl: process.env.NESSIE_BASE_URL ?? '',
    });
  const finance = createFinanceService({
    store: LedgerStore.open(databasePath), bank,
    clock: { now: () => new Date() }, newId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
  });
  try {
    await finance.bootstrapHousehold(household);
    const seeded = await finance.seedDemoBanking(household);
    await finance.bootstrapHousehold(seeded);
    const initialCycle = seeded.demoCycles[0];
    if (!initialCycle) throw new Error('The household has no configured demo cycle to seed.');
    for (const [index, bill] of initialCycle.bills.entries()) {
      const sourceEventId = `seed:${seeded.householdId}:${initialCycle.cycleId}:${index}`;
      const identity = JSON.stringify([seeded.householdId, sourceEventId, 'add_bill']);
      const commandId = `cmd-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
      const result = await finance.execute({
        commandId,
        actorId: seeded.designatedPayerId,
        householdId: seeded.householdId,
        sourceEventId,
        payload: { kind: 'add_bill', ...bill, cycleId: initialCycle.cycleId },
      });
      if (result.kind === 'rejected') throw new Error(`Could not seed ${bill.title}: ${result.userMessage}`);
    }
    console.log(`Seeded ${bankMode} household ${seeded.householdId} at ${databasePath}.`);
  } finally { await finance.close(); }
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
