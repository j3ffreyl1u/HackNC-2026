import { formatUsd } from './accounting.js';
import type { Ledger } from './ledger.js';
import type { IdGenerator } from './runtime.js';
import type { Clock } from './runtime.js';
import type { LedgerStore } from './store.js';

const HOUR_MS = 60 * 60 * 1000;
/** Reminders begin this long before the due date. */
export const REMINDER_WINDOW_MS = 48 * HOUR_MS;
/** At most one reminder per member per bill in this period. */
export const REMINDER_INTERVAL_MS = 24 * HOUR_MS;
/** A hard stop so nobody is nagged indefinitely. */
export const MAX_REMINDERS_PER_BILL = 3;

/**
 * Limited, private payment reminders. Never public, never repeated within a day, and silent for anyone
 * with nothing left to approve: paid, pending, declined, or covered by an agreement awaiting approval.
 * Missing a contribution is not treated as misconduct; this is a nudge, not a callout.
 */
export class Reminders {
  constructor(
    private readonly store: LedgerStore,
    private readonly ledger: Ledger,
    private readonly clock: Clock,
  ) {}

  process(householdId: string): void {
    const household = this.ledger.household(householdId);
    if (!household) return;
    const nowMs = this.clock.now().getTime();
    const nowIso = this.clock.now().toISOString();
    const names = new Map(this.ledger.members(householdId).map((m) => [m.userId, m.displayName]));

    this.store.tx(() => {
      for (const bill of this.ledger.billsForHousehold(householdId)) {
        if (bill.status !== 'collecting') continue; // ready, paid or failed: nothing left to collect
        const dueMs = Date.parse(`${bill.dueDate}T00:00:00Z`);
        if (Number.isNaN(dueMs) || nowMs < dueMs - REMINDER_WINDOW_MS) continue;

        const coverageHeld = new Set<string>();
        for (const request of this.ledger.activeCoverageRequests(bill.billId)) {
          if (request.status !== 'awaiting_approvals') continue;
          coverageHeld.add(request.debtorId);
          if (request.volunteerId) coverageHeld.add(request.volunteerId);
        }

        for (const proposal of this.ledger.proposalsForBill(bill.billId)) {
          if (proposal.purpose !== 'contribution' || proposal.status !== 'proposed') continue;
          const userId = proposal.requiredActorIds[0];
          if (!names.has(userId) || coverageHeld.has(userId)) continue;
          if (this.store.approvalsFor(proposal.proposalId, proposal.version).includes(userId)) continue;

          const sentKey = `reminder_count:${bill.billId}:${userId}`;
          const lastKey = `reminder_last:${bill.billId}:${userId}`;
          const count = Number(this.store.getMeta(householdId, sentKey) ?? '0');
          const last = this.store.getMeta(householdId, lastKey);
          if (count >= MAX_REMINDERS_PER_BILL) continue;
          if (last !== null && nowMs - Date.parse(last) < REMINDER_INTERVAL_MS) continue;

          this.store.enqueueOutbox(
            {
              deliveryId: `deliv:reminder:${bill.billId}:${userId}:${count + 1}`,
              householdId,
              audience: { kind: 'private', userId },
              text:
                `Reminder: your ${formatUsd(proposal.amountCents)} request for ${bill.title} is due ${bill.dueDate}. ` +
                `React 👍 to this message or reply "approve ${proposal.proposalId} v${proposal.version}" when you're ready. ` +
                `If that doesn't work for you, tell me and I can help. (Simulated household account.)`,
              proposalRef: { proposalId: proposal.proposalId, proposalVersion: proposal.version },
            },
            nowIso,
          );
          this.store.setMeta(householdId, sentKey, String(count + 1));
          this.store.setMeta(householdId, lastKey, nowIso);
        }
      }
    });
  }
}
