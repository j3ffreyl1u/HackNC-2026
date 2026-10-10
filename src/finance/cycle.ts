import { formatUsd } from './accounting.js';
import type { Billing } from './billing.js';
import type { Ledger } from './ledger.js';
import { CycleTransitionError } from './runtime.js';
import type { LedgerStore } from './store.js';
import type { Notifier, Scope } from './support.js';

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
    private readonly notify: Notifier,
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
      const created = this.billing.createBills(
        scope,
        this.ledger.members(householdId),
        config.demoCycles[target].bills.map((b) => ({ ...b, cycleId })),
      );
      this.notify.toGroup(scope, `deliv:statement:${householdId}:${cycleId}`, this.statement(householdId, current as string, cycleId, created));
    });
  }

  /** The monthly statement: what closed last cycle, what is due now, and how prior credit is being repaid. */
  private statement(
    householdId: string,
    previousCycleId: string,
    cycleId: string,
    created: Array<{ billId: string; title: string; amountCents: number; dueDate: string }>,
  ): string {
    const names = new Map(this.ledger.members(householdId).map((m) => [m.userId, m.displayName]));
    const name = (id: string) => names.get(id) ?? id;
    const closed = this.ledger.billsForCycle(householdId, previousCycleId);
    const parts = [`${cycleId} statement (simulated household account).`];
    if (closed.length > 0) {
      parts.push(`Closed ${previousCycleId}: ${closed.map((b) => `${b.title} ${formatUsd(b.amountCents)} paid`).join(', ')}.`);
    }
    parts.push(
      created.length > 0
        ? `Due now: ${created.map((b) => `${b.title} ${formatUsd(b.amountCents)} by ${b.dueDate}`).join(', ')}.`
        : 'No bills are due yet.',
    );
    for (const settlement of this.ledger.pendingSettlements(householdId).filter((s) => s.cycleId === cycleId)) {
      const debt = this.ledger.debt(settlement.debtId);
      if (!debt) continue;
      parts.push(
        `Prior credit: ${name(debt.debtorId)} owes ${name(debt.creditorId)} ${formatUsd(debt.remainingCents)} from an earlier bill. ` +
          `${name(debt.debtorId)}'s requests include ${formatUsd(settlement.amountCents)} of repayment and ` +
          `${name(debt.creditorId)}'s are reduced by the same amount. The debt is cleared only once both payments are confirmed.`,
      );
    }
    return parts.join(' ');
  }
}
