import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FinanceService, HouseholdConfig } from '../contracts/index.js';
import { createFinanceService } from '../finance/index.js';
import { MockBank } from '../finance/mock-bank.js';
import { NessieBank } from '../finance/nessie.js';
import { LedgerStore } from '../finance/store.js';
import { prepareMockBankBootstrap } from './banking.js';
import { loadAppConfig } from './config.js';
import { createAppServer } from './server.js';

async function main(): Promise<void> {
  const config = await loadAppConfig();
  await mkdir(dirname(config.databasePath), { recursive: true });
  const store = LedgerStore.open(config.databasePath);

  let household: HouseholdConfig;
  let bank;
  if (config.bankMode === 'nessie') {
    household = config.household;
    bank = new NessieBank({ apiKey: config.nessieApiKey!, baseUrl: config.nessieBaseUrl! });
  } else {
    const mock = prepareMockBankBootstrap(config.household, (householdId, key) => store.getMeta(householdId, key));
    household = mock.household;
    bank = new MockBank({ balances: mock.balances });
  }

  const financeCore = createFinanceService({
    store, bank, clock: { now: () => new Date() }, newId: (prefix) => `${prefix}-${randomUUID()}`,
  });
  // LedgerStore has the durable uncertainty transition; expose it at the C wiring boundary so
  // the app can quarantine a message after a timeout without changing Finance's public contract.
  const finance: FinanceService = {
    ...financeCore,
    markDeliveryUncertain: async (deliveryId) => { store.markDeliveryUncertain(deliveryId); },
  };

  try {
    await finance.bootstrapHousehold(household);
    const server = createAppServer({ finance, config: household, demoMode: config.demoMode });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', resolve);
    });
    console.log(`Splitbot ledger: http://127.0.0.1:${config.port} (BANK_MODE=${config.bankMode})`);

    let reconcileRunning = false;
    let remindersRunning = false;
    const reconcile = async () => {
      if (reconcileRunning) return;
      reconcileRunning = true;
      try { await finance.reconcile(household.householdId); }
      catch (error) { console.error('Scheduled reconciliation failed:', error instanceof Error ? error.message : 'unknown error'); }
      finally { reconcileRunning = false; }
    };
    const reminders = async () => {
      if (remindersRunning) return;
      remindersRunning = true;
      try { await finance.processReminders(household.householdId); }
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
