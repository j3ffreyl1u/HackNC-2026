import type { Server } from 'node:http';
import type { ConversationService, FinanceService, HouseholdConfig } from '../contracts/index.js';
import { createEventHandler, drainOutbox } from './events.js';

export interface RuntimeOptions {
  server: Server;
  conversation: ConversationService;
  finance: FinanceService;
  household: HouseholdConfig;
  port: number;
  onError?: (task: string, error: unknown) => void;
}

/** Owns provider intake, local HTTP lifecycle, persisted message delivery, and finance timers. */
export function createApplicationRuntime(options: RuntimeOptions) {
  let started = false;
  let stopping = false;
  let reconcileBusy = false;
  let remindersBusy = false;
  let deliveryBusy = false;
  let financeTimer: ReturnType<typeof setInterval> | undefined;
  let remindersTimer: ReturnType<typeof setInterval> | undefined;
  let stopPromise: Promise<void> | undefined;
  const active = new Set<Promise<void>>();
  const onError = options.onError ?? ((task, error) => console.error(`${task} failed:`, error instanceof Error ? error.message : 'unknown error'));
  const onMessage = createEventHandler(options.conversation, options.finance);

  const runTask = (task: string, work: () => Promise<void>, busy: () => boolean, setBusy: (value: boolean) => void): Promise<void> => {
    if (stopping || busy()) return Promise.resolve();
    setBusy(true);
    const promise = work().catch((error) => onError(task, error)).finally(() => {
      setBusy(false);
      active.delete(promise);
    });
    active.add(promise);
    return promise;
  };
  const runReconciliation = () => runTask('Reconciliation', () => options.finance.reconcile(options.household.householdId), () => reconcileBusy, (v) => { reconcileBusy = v; });
  const runDelivery = () => runTask('Outbox delivery', () => drainOutbox(options.conversation, options.finance), () => deliveryBusy, (v) => { deliveryBusy = v; });
  const runReminders = () => runTask('Reminder processing', () => options.finance.processReminders(options.household.householdId), () => remindersBusy, (v) => { remindersBusy = v; });

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    if (!started) return Promise.resolve();
    stopping = true;
    stopPromise = (async () => {
      if (financeTimer) clearInterval(financeTimer);
      if (remindersTimer) clearInterval(remindersTimer);
      try { await options.conversation.stop(); }
      finally {
        if (options.server.listening) await new Promise<void>((resolve) => options.server.close(() => resolve()));
        while (active.size) await Promise.allSettled([...active]);
        await options.finance.close();
      }
    })();
    return stopPromise;
  };

  return {
    async start(): Promise<void> {
      if (started) return;
      await new Promise<void>((resolve, reject) => {
        options.server.once('error', reject);
        options.server.listen(options.port, '127.0.0.1', resolve);
      });
      try {
        await options.conversation.start(onMessage);
        started = true;
      } catch (error) {
        if (options.server.listening) await new Promise<void>((resolve) => options.server.close(() => resolve()));
        throw error;
      }
      financeTimer = setInterval(() => { void runReconciliation(); void runDelivery(); }, 5_000);
      remindersTimer = setInterval(() => { void runReminders(); }, 60_000);
      void runDelivery();
    },
    stop,
    /** Manual scheduler hooks for deterministic tests and an operator tick. */
    runReconciliation,
    runDelivery,
    runReminders,
  };
}
