import { randomUUID } from 'node:crypto';
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
    clock: { now: () => new Date() }, newId: (prefix) => `${prefix}-${randomUUID()}`,
  });
  try {
    await finance.bootstrapHousehold(config.household);
    // Mock resources are process-local. Reuse the ledger's saved account mapping and seed the
    // fresh in-memory bank so a local demo starts with the documented balances after restart.
    const resolved = await finance.seedDemoBanking(config.household);
    await finance.bootstrapHousehold(resolved);
    const server = createAppServer({ finance, config: resolved, demoMode: config.demoMode });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', resolve);
    });
    console.log(`Splitbot ledger: http://127.0.0.1:${config.port} (mock bank)`);

    let reconcileRunning = false;
    let remindersRunning = false;
    const reconcile = async () => {
      if (reconcileRunning) return;
      reconcileRunning = true;
      try { await finance.reconcile(resolved.householdId); }
      catch (error) { console.error('Scheduled reconciliation failed:', error instanceof Error ? error.message : 'unknown error'); }
      finally { reconcileRunning = false; }
    };
    const reminders = async () => {
      if (remindersRunning) return;
      remindersRunning = true;
      try { await finance.processReminders(resolved.householdId); }
      catch (error) { console.error('Scheduled reminder task failed:', error instanceof Error ? error.message : 'unknown error'); }
      finally { remindersRunning = false; }
    };
    const reconcileTimer = setInterval(() => void reconcile(), 5_000);
    const reminderTimer = setInterval(() => void reminders(), 60_000);

    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      clearInterval(reconcileTimer);
      clearInterval(reminderTimer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      while (reconcileRunning || remindersRunning) await new Promise((resolve) => setTimeout(resolve, 10));
      await finance.close();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  } catch (error) {
    await finance.close();
    throw error;
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
