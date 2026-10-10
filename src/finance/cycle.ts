import type { Billing } from './billing.js';
import type { Ledger } from './ledger.js';
import { CycleTransitionError } from './runtime.js';
import type { LedgerStore } from './store.js';
import type { Scope } from './support.js';

/**
 * Demo cycle control. The app clock moves forward one configured cycle at a time; the bank's clock does
 * not. Advancing creates the next cycle's configured bills with their credit-adjusted requests and
 * reserves a pending settlement, but never clears a debt: only confirmed payments do that.
 */
export class CycleFlow {
  constructor(
    private readonly store: LedgerStore,
    private readonly ledger: Ledger,
    private readonly billing: Billing,
    private readonly now: () => string,
  ) {}

  /**
   * Idempotent for the target cycle (a second call is a no-op), and atomic: any refusal changes nothing.
   * Throws `CycleTransitionError` when the move is not allowed.
   */
  advance(householdId: string, cycleId: string): void {
    this.store.tx(() => {
      const config = this.store.getHouseholdConfig(householdId);
      const household = this.ledger.household(householdId);
      if (!config || !household) throw new CycleTransitionError('unknown_household', `Unknown household ${householdId}.`);

      const current = this.ledger.currentCycle(householdId);
      if (current === cycleId) return;

      const order = config.demoCycles.map((c) => c.cycleId);
      const target = order.indexOf(cycleId);
      if (target < 0) throw new CycleTransitionError('unknown_cycle', `Cycle ${cycleId} is not configured.`);
      const from = current === null ? -1 : order.indexOf(current);
      if (from < 0 || target !== from + 1) {
        throw new CycleTransitionError('not_next', `Only the next configured cycle after ${current ?? 'none'} can be started.`);
      }
      if (this.ledger.billsForCycle(householdId, current as string).some((b) => b.status !== 'paid')) {
        throw new CycleTransitionError('prior_unpaid', `Every ${current} bill must be paid before ${cycleId} starts.`);
      }
      if (this.store.unresolvedBankOperations(householdId).length > 0) {
        throw new CycleTransitionError('unresolved_operations', 'A bank transfer is still unresolved. Reconcile it first.');
      }

      this.store.setMeta(householdId, 'current_cycle', cycleId);
      const scope: Scope = {
        householdId,
        groupSpaceId: household.groupSpaceId,
        householdAccountId: household.householdAccountId,
        now: this.now(),
      };
      this.billing.createBills(
        scope,
        this.ledger.members(householdId),
        config.demoCycles[target].bills.map((b) => ({ ...b, cycleId })),
      );
    });
  }
}
