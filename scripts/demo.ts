import { readFile } from 'node:fs/promises';
import type { HouseholdConfig } from '../src/contracts/index.js';
import { createFinanceService } from '../src/finance/index.js';
import { MockBank } from '../src/finance/mock-bank.js';
import { LedgerStore } from '../src/finance/store.js';

async function main() {
  const config = JSON.parse(await readFile(process.env.HOUSEHOLD_CONFIG_PATH ?? 'tests/fixtures/household.json', 'utf8')) as HouseholdConfig;
  const finance = createFinanceService({ store: LedgerStore.open(process.env.DATABASE_PATH ?? 'data/splitbot.sqlite'), bank: new MockBank(), clock: { now: () => new Date() }, newId: (p) => `${p}-${crypto.randomUUID()}` });
  try {
    await finance.bootstrapHousehold(config);
    const snapshot = await finance.getSnapshot(config.householdId);
    const index = config.demoCycles.findIndex((cycle) => cycle.cycleId === snapshot.cycleId);
    const next = config.demoCycles[index + 1];
    if (!next) throw new Error(`No cycle follows ${snapshot.cycleId}`);
    await finance.advanceDemoCycle(config.householdId, next.cycleId);
    console.log(`Advanced ${config.householdId} to ${next.cycleId}.`);
  } finally { await finance.close(); }
}
void main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
