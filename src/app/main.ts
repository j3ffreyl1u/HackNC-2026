import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createFinanceService } from '../finance/index.js';
import { MockBank } from '../finance/mock-bank.js';
import { LedgerStore } from '../finance/store.js';
import { loadAppConfig } from './config.js';
import { createAppServer } from './server.js';

async function main(): Promise<void> {
  const config = await loadAppConfig();
  await mkdir(dirname(config.databasePath), { recursive: true });
  const finance = createFinanceService({
    store: LedgerStore.open(config.databasePath), bank: new MockBank(),
    clock: { now: () => new Date() }, newId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
  });
  await finance.bootstrapHousehold(config.household);
  const server = createAppServer({ finance, config: config.household, demoMode: config.demoMode });
  server.listen(config.port, '127.0.0.1', () => console.log(`Splitbot ledger: http://127.0.0.1:${config.port} (mock bank)`));
  let running = false;
  let reminderRunning = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await finance.reconcile(config.household.householdId); }
    catch (error) { console.error('Scheduled finance task failed:', error instanceof Error ? error.message : 'unknown error'); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 5_000);
  const reminderTimer = setInterval(() => {
    if (reminderRunning) return;
    reminderRunning = true;
    void finance.processReminders(config.household.householdId)
      .catch((error) => console.error('Reminder task failed:', error instanceof Error ? error.message : 'unknown error'))
      .finally(() => { reminderRunning = false; });
  }, 60_000);
  const shutdown = async () => {
    clearInterval(timer);
    clearInterval(reminderTimer);
    server.close();
    await finance.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
