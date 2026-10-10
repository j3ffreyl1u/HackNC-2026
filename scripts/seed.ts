import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HouseholdConfig } from '../src/contracts/index.js';
import { createFinanceService } from '../src/finance/index.js';
import { MockBank } from '../src/finance/mock-bank.js';
import { LedgerStore } from '../src/finance/store.js';

async function main() {
  if (process.env.BANK_MODE && process.env.BANK_MODE !== 'mock') throw new Error('Seed supports BANK_MODE=mock only in this build.');
  if (process.argv.includes('--reset')) throw new Error('--reset is intentionally unavailable; choose a fresh DATABASE_PATH for a clean mock demo.');
  const config = JSON.parse(await readFile(process.env.HOUSEHOLD_CONFIG_PATH ?? 'tests/fixtures/household.json', 'utf8')) as HouseholdConfig;
  const path = process.env.DATABASE_PATH ?? 'data/splitbot.sqlite'; await mkdir(dirname(path), { recursive: true });
  const finance = createFinanceService({ store: LedgerStore.open(path), bank: new MockBank(), clock: { now: () => new Date() }, newId: (p) => `${p}-${crypto.randomUUID()}` });
  try { await finance.bootstrapHousehold(config); const resolved = await finance.seedDemoBanking(config); await finance.bootstrapHousehold(resolved); console.log(`Seeded ${resolved.householdId}. Mock bank balances exist only for this process.`); }
  finally { await finance.close(); }
}
void main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
