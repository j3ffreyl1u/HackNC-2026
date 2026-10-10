import type { LedgerStore } from './store.js';

// Typed queries over the ledger tables, shared by the engine, coverage and reconciliation.
// Everything here is synchronous so callers can compose it inside `store.tx`.

export type ProposalPurpose = 'contribution' | 'coverage' | 'bill_payment';
export type ProposalStatus =
  | 'proposed'
  | 'approved'
  | 'submitted'
  | 'pending'
  | 'unknown'
  | 'confirmed'
  | 'failed'
  | 'declined'
  | 'superseded';
export type BillStatus = 'draft' | 'collecting' | 'ready' | 'paid' | 'failed';
export type AllocationKind = 'own' | 'coverage' | 'credit_settlement';

export interface BillRecord {
  billId: string;
  householdId: string;
  cycleId: string;
  title: string;
  amountCents: number;
  dueDate: string;
  recipientId: string;
  status: BillStatus;
}

export interface AllocationLine {
  payerId: string;
  beneficiaryId: string;
  amountCents: number;
  kind: AllocationKind;
}

export interface ProposalRecord {
  proposalId: string;
  householdId: string;
  billId: string;
  purpose: ProposalPurpose;
  version: number;
  status: ProposalStatus;
  amountCents: number;
  sourceAccountId: string;
  destinationAccountId: string;
  requiredActorIds: string[];
  allocation: AllocationLine[];
  description: string;
}

export type CoverageStatus = 'awaiting_share_consent' | 'closed' | 'open' | 'awaiting_approvals' | 'funded' | 'failed';

export interface CoverageRequestRecord {
  requestId: string;
  householdId: string;
  billId: string;
  debtorId: string;
  volunteerId?: string;
  amountCents: number;
  status: CoverageStatus;
  proposalId?: string;
  /** Contribution proposals this agreement replaced; revived if the agreement falls through. */
  supersededProposalIds: string[];
}

/** Requests that still need a decision from someone. */
export const ACTIVE_COVERAGE_STATUSES: readonly CoverageStatus[] = ['awaiting_share_consent', 'open', 'awaiting_approvals'];

export interface MemberRecord {
  userId: string;
  displayName: string;
  bankAccountId: string;
}

export interface RecipientRecord {
  recipientId: string;
  displayName: string;
  bankAccountId: string;
}

export interface HouseholdRecord {
  householdId: string;
  groupSpaceId: string;
  designatedPayerId: string;
  householdAccountId: string;
}

export interface CreditApplication {
  billId: string;
  amountCents: number;
}

export interface SettlementRecord {
  settlementId: string;
  debtId: string;
  cycleId: string;
  amountCents: number;
  status: 'pending' | 'applied';
  applications: CreditApplication[];
}

export interface DebtRecord {
  debtId: string;
  householdId: string;
  debtorId: string;
  creditorId: string;
  originalCents: number;
  remainingCents: number;
  sourceBillId: string;
}

interface BillRow {
  bill_id: string;
  household_id: string;
  cycle_id: string;
  title: string;
  amount_cents: number;
  due_date: string;
  recipient_id: string;
  status: BillStatus;
}

interface ProposalRow {
  proposal_id: string;
  household_id: string;
  bill_id: string;
  purpose: ProposalPurpose;
  version: number;
  status: ProposalStatus;
  amount_cents: number;
  source_account_id: string;
  destination_account_id: string;
  required_actor_ids: string;
  allocation_json: string;
  description: string;
}

interface CoverageRow {
  request_id: string;
  household_id: string;
  bill_id: string;
  debtor_id: string;
  volunteer_id: string | null;
  amount_cents: number;
  status: CoverageStatus;
  proposal_id: string | null;
  superseded_json: string;
}

const toCoverage = (r: CoverageRow): CoverageRequestRecord => ({
  requestId: r.request_id,
  householdId: r.household_id,
  billId: r.bill_id,
  debtorId: r.debtor_id,
  ...(r.volunteer_id ? { volunteerId: r.volunteer_id } : {}),
  amountCents: r.amount_cents,
  status: r.status,
  ...(r.proposal_id ? { proposalId: r.proposal_id } : {}),
  supersededProposalIds: JSON.parse(r.superseded_json) as string[],
});

interface DebtRow {
  debt_id: string;
  household_id: string;
  debtor_id: string;
  creditor_id: string;
  original_cents: number;
  remaining_cents: number;
  source_bill_id: string;
}

const toDebt = (r: DebtRow): DebtRecord => ({
  debtId: r.debt_id,
  householdId: r.household_id,
  debtorId: r.debtor_id,
  creditorId: r.creditor_id,
  originalCents: r.original_cents,
  remainingCents: r.remaining_cents,
  sourceBillId: r.source_bill_id,
});

interface SettlementRow {
  settlement_id: string;
  debt_id: string;
  cycle_id: string;
  amount_cents: number;
  status: 'pending' | 'applied';
  applications_json: string;
}

const toSettlement = (r: SettlementRow): SettlementRecord => ({
  settlementId: r.settlement_id,
  debtId: r.debt_id,
  cycleId: r.cycle_id,
  amountCents: r.amount_cents,
  status: r.status,
  applications: JSON.parse(r.applications_json) as CreditApplication[],
});

const toBill = (r: BillRow): BillRecord => ({
  billId: r.bill_id,
  householdId: r.household_id,
  cycleId: r.cycle_id,
  title: r.title,
  amountCents: r.amount_cents,
  dueDate: r.due_date,
  recipientId: r.recipient_id,
  status: r.status,
});

const toProposal = (r: ProposalRow): ProposalRecord => ({
  proposalId: r.proposal_id,
  householdId: r.household_id,
  billId: r.bill_id,
  purpose: r.purpose,
  version: r.version,
  status: r.status,
  amountCents: r.amount_cents,
  sourceAccountId: r.source_account_id,
  destinationAccountId: r.destination_account_id,
  requiredActorIds: JSON.parse(r.required_actor_ids) as string[],
  allocation: JSON.parse(r.allocation_json) as AllocationLine[],
  description: r.description,
});

/** Proposals that can no longer be acted on. */
export const TERMINAL_PROPOSAL_STATUSES: readonly ProposalStatus[] = ['declined', 'superseded', 'failed', 'confirmed'];

export class Ledger {
  constructor(private readonly store: LedgerStore) {}

  private get db() {
    return this.store.db;
  }

  // ---- enrollment ---------------------------------------------------------

  household(householdId: string): HouseholdRecord | null {
    const row = this.db
      .prepare(
        `SELECT household_id, group_space_id, designated_payer_id, household_account_id
           FROM households WHERE household_id = ?`,
      )
      .get(householdId) as
      | { household_id: string; group_space_id: string; designated_payer_id: string; household_account_id: string }
      | undefined;
    return row
      ? {
          householdId: row.household_id,
          groupSpaceId: row.group_space_id,
          designatedPayerId: row.designated_payer_id,
          householdAccountId: row.household_account_id,
        }
      : null;
  }

  members(householdId: string): MemberRecord[] {
    const rows = this.db
      .prepare('SELECT user_id, display_name, bank_account_id FROM members WHERE household_id = ? ORDER BY position')
      .all(householdId) as Array<{ user_id: string; display_name: string; bank_account_id: string }>;
    return rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, bankAccountId: r.bank_account_id }));
  }

  member(householdId: string, userId: string): MemberRecord | null {
    return this.members(householdId).find((m) => m.userId === userId) ?? null;
  }

  recipient(householdId: string, recipientId: string): RecipientRecord | null {
    const row = this.db
      .prepare(
        'SELECT recipient_id, display_name, bank_account_id FROM recipients WHERE household_id = ? AND recipient_id = ?',
      )
      .get(householdId, recipientId) as
      | { recipient_id: string; display_name: string; bank_account_id: string }
      | undefined;
    return row
      ? { recipientId: row.recipient_id, displayName: row.display_name, bankAccountId: row.bank_account_id }
      : null;
  }

  currentCycle(householdId: string): string | null {
    return this.store.getMeta(householdId, 'current_cycle');
  }

  // ---- bills --------------------------------------------------------------

  bill(billId: string): BillRecord | null {
    const row = this.db.prepare('SELECT * FROM bills WHERE bill_id = ?').get(billId) as BillRow | undefined;
    return row ? toBill(row) : null;
  }

  billsForCycle(householdId: string, cycleId: string): BillRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM bills WHERE household_id = ? AND cycle_id = ? ORDER BY created_at, bill_id')
      .all(householdId, cycleId) as BillRow[];
    return rows.map(toBill);
  }

  insertBill(bill: BillRecord, now: string): void {
    this.db
      .prepare(
        `INSERT INTO bills (bill_id, household_id, cycle_id, title, amount_cents, due_date, recipient_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bill.billId,
        bill.householdId,
        bill.cycleId,
        bill.title,
        bill.amountCents,
        bill.dueDate,
        bill.recipientId,
        bill.status,
        now,
      );
  }

  updateBillTerms(billId: string, terms: { title: string; amountCents: number; dueDate: string; recipientId: string }): void {
    this.db
      .prepare('UPDATE bills SET title = ?, amount_cents = ?, due_date = ?, recipient_id = ? WHERE bill_id = ?')
      .run(terms.title, terms.amountCents, terms.dueDate, terms.recipientId, billId);
  }

  setBillStatus(billId: string, status: BillStatus): void {
    this.db.prepare('UPDATE bills SET status = ? WHERE bill_id = ?').run(status, billId);
  }

  /** Replace the agreed shares for a bill (only valid before any money is confirmed). */
  setObligations(billId: string, agreed: Record<string, number>): void {
    this.db.prepare('DELETE FROM obligations WHERE bill_id = ?').run(billId);
    const insert = this.db.prepare('INSERT INTO obligations (bill_id, user_id, agreed_cents) VALUES (?, ?, ?)');
    for (const [userId, cents] of Object.entries(agreed)) insert.run(billId, userId, cents);
  }

  obligations(billId: string): Record<string, number> {
    const rows = this.db.prepare('SELECT user_id, agreed_cents FROM obligations WHERE bill_id = ?').all(billId) as Array<{
      user_id: string;
      agreed_cents: number;
    }>;
    return Object.fromEntries(rows.map((r) => [r.user_id, r.agreed_cents]));
  }

  /** Cents a member still owes on a bill: agreed share minus what the bank has confirmed for them. */
  remainingShare(billId: string, userId: string): number {
    const agreed = this.obligations(billId)[userId] ?? 0;
    const confirmed = this.confirmedByBeneficiary(billId)[userId] ?? 0;
    return Math.max(0, agreed - confirmed);
  }

  /** Confirmed carried-over credit that `debtorId` paid toward `creditorId`'s share of a bill. */
  confirmedCredit(billId: string, debtorId: string, creditorId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM allocations
          WHERE bill_id = ? AND payer_id = ? AND beneficiary_id = ? AND kind = 'credit_settlement'`,
      )
      .get(billId, debtorId, creditorId) as { cents: number };
    return row.cents;
  }

  /** Confirmed cents credited to each beneficiary of a bill. */
  confirmedByBeneficiary(billId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT beneficiary_id, SUM(amount_cents) AS cents FROM allocations WHERE bill_id = ? GROUP BY beneficiary_id')
      .all(billId) as Array<{ beneficiary_id: string; cents: number }>;
    return Object.fromEntries(rows.map((r) => [r.beneficiary_id, r.cents]));
  }

  confirmedTotal(billId: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM allocations WHERE bill_id = ?').get(billId) as {
      cents: number;
    };
    return row.cents;
  }

  // ---- proposals ----------------------------------------------------------

  proposal(proposalId: string): ProposalRecord | null {
    const row = this.db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(proposalId) as ProposalRow | undefined;
    return row ? toProposal(row) : null;
  }

  proposalsForBill(billId: string): ProposalRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM proposals WHERE bill_id = ? ORDER BY created_at, proposal_id')
      .all(billId) as ProposalRow[];
    return rows.map(toProposal);
  }

  insertProposal(p: ProposalRecord, now: string): void {
    this.db
      .prepare(
        `INSERT INTO proposals (proposal_id, household_id, bill_id, purpose, version, status, amount_cents,
           source_account_id, destination_account_id, required_actor_ids, allocation_json, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.proposalId,
        p.householdId,
        p.billId,
        p.purpose,
        p.version,
        p.status,
        p.amountCents,
        p.sourceAccountId,
        p.destinationAccountId,
        JSON.stringify(p.requiredActorIds),
        JSON.stringify(p.allocation),
        p.description,
        now,
        now,
      );
  }

  setProposalStatus(proposalId: string, status: ProposalStatus, now: string): void {
    this.db.prepare('UPDATE proposals SET status = ?, updated_at = ? WHERE proposal_id = ?').run(status, now, proposalId);
  }

  /** Re-issue a proposal at a new version with new terms. Prior approvals stay on the old version. */
  reviseProposal(
    proposalId: string,
    revision: { version: number; amountCents: number; allocation: AllocationLine[]; description: string },
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE proposals SET version = ?, status = 'proposed', amount_cents = ?, allocation_json = ?,
                description = ?, updated_at = ? WHERE proposal_id = ?`,
      )
      .run(revision.version, revision.amountCents, JSON.stringify(revision.allocation), revision.description, now, proposalId);
  }

  /**
   * Bank operations on a bill's proposals that were sent and have not failed (money may have moved,
   * or may yet move). A `prepared` operation was never sent, so it does not count.
   */
  liveBankOperationCount(billId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM bank_operations o JOIN proposals p ON p.proposal_id = o.proposal_id
          WHERE p.bill_id = ? AND o.status NOT IN ('failed', 'prepared')`,
      )
      .get(billId) as { n: number };
    return row.n;
  }

  /**
   * Cents already committed to leaving the household account for this bill: outgoing payments that were
   * sent (and may have moved money) or completed. A never-sent or failed operation commits nothing.
   */
  committedOutgoingCents(billId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(o.amount_cents), 0) AS cents
           FROM bank_operations o JOIN proposals p ON p.proposal_id = o.proposal_id
          WHERE p.bill_id = ? AND p.purpose = 'bill_payment'
            AND o.status IN ('submitted', 'pending', 'unknown', 'confirmed')`,
      )
      .get(billId) as { cents: number };
    return row.cents;
  }

  /** Funds confirmed for this bill and not yet spent on it. One bill's money never pays another's. */
  reservedFunds(billId: string): number {
    return this.confirmedTotal(billId) - this.committedOutgoingCents(billId);
  }

  /** Cancel never-sent operations on a bill (for example because its terms changed). Returns how many. */
  cancelPreparedOperations(billId: string, reason: string, now: string): number {
    const result = this.db
      .prepare(
        `UPDATE bank_operations SET status = 'failed', reason = ?, updated_at = ?
          WHERE status = 'prepared'
            AND proposal_id IN (SELECT proposal_id FROM proposals WHERE bill_id = ?)`,
      )
      .run(reason, now, billId);
    return result.changes;
  }

  cancelPreparedOperationsForProposal(proposalId: string, reason: string, now: string): number {
    const result = this.db
      .prepare(
        `UPDATE bank_operations SET status = 'failed', reason = ?, updated_at = ?
          WHERE status = 'prepared' AND proposal_id = ?`,
      )
      .run(reason, now, proposalId);
    return result.changes;
  }

  insertAllocation(
    allocation: AllocationLine & { allocationId: string; billId: string; operationId: string },
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO allocations (allocation_id, bill_id, payer_id, beneficiary_id, amount_cents, operation_id, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        allocation.allocationId,
        allocation.billId,
        allocation.payerId,
        allocation.beneficiaryId,
        allocation.amountCents,
        allocation.operationId,
        allocation.kind,
        now,
      );
  }

  // ---- coverage requests ----------------------------------------------------

  insertCoverageRequest(r: CoverageRequestRecord, now: string): void {
    this.db
      .prepare(
        `INSERT INTO coverage_requests (request_id, household_id, bill_id, debtor_id, volunteer_id, amount_cents,
           status, proposal_id, superseded_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.requestId,
        r.householdId,
        r.billId,
        r.debtorId,
        r.volunteerId ?? null,
        r.amountCents,
        r.status,
        r.proposalId ?? null,
        JSON.stringify(r.supersededProposalIds),
        now,
        now,
      );
  }

  coverageRequest(requestId: string): CoverageRequestRecord | null {
    const row = this.db.prepare('SELECT * FROM coverage_requests WHERE request_id = ?').get(requestId) as
      | CoverageRow
      | undefined;
    return row ? toCoverage(row) : null;
  }

  coverageRequestForProposal(proposalId: string): CoverageRequestRecord | null {
    const row = this.db.prepare('SELECT * FROM coverage_requests WHERE proposal_id = ?').get(proposalId) as
      | CoverageRow
      | undefined;
    return row ? toCoverage(row) : null;
  }

  /** Requests on a bill that are still waiting on someone, oldest first. */
  activeCoverageRequests(billId: string): CoverageRequestRecord[] {
    const placeholders = ACTIVE_COVERAGE_STATUSES.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM coverage_requests WHERE bill_id = ? AND status IN (${placeholders}) ORDER BY created_at, request_id`,
      )
      .all(billId, ...ACTIVE_COVERAGE_STATUSES) as CoverageRow[];
    return rows.map(toCoverage);
  }

  updateCoverageRequest(
    requestId: string,
    patch: {
      status: CoverageStatus;
      volunteerId?: string | null;
      amountCents?: number;
      proposalId?: string | null;
      supersededProposalIds?: string[];
    },
    now: string,
  ): void {
    const current = this.coverageRequest(requestId);
    if (!current) throw new Error(`unknown coverage request ${requestId}`);
    this.db
      .prepare(
        `UPDATE coverage_requests SET status = ?, volunteer_id = ?, amount_cents = ?, proposal_id = ?,
                superseded_json = ?, updated_at = ? WHERE request_id = ?`,
      )
      .run(
        patch.status,
        patch.volunteerId === undefined ? (current.volunteerId ?? null) : patch.volunteerId,
        patch.amountCents ?? current.amountCents,
        patch.proposalId === undefined ? (current.proposalId ?? null) : patch.proposalId,
        JSON.stringify(patch.supersededProposalIds ?? current.supersededProposalIds),
        now,
        requestId,
      );
  }

  // ---- debts --------------------------------------------------------------

  /** Debts with something left to pay and no settlement yet (one settlement per debt in this MVP). */
  unsettledDebts(householdId: string): DebtRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM debts d WHERE d.household_id = ? AND d.remaining_cents > 0
            AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.debt_id = d.debt_id)
          ORDER BY d.created_at, d.debt_id`,
      )
      .all(householdId) as DebtRow[];
    return rows.map(toDebt);
  }

  debt(debtId: string): DebtRecord | null {
    const row = this.db.prepare('SELECT * FROM debts WHERE debt_id = ?').get(debtId) as DebtRow | undefined;
    return row ? toDebt(row) : null;
  }

  reduceDebt(debtId: string, amountCents: number): void {
    this.db.prepare('UPDATE debts SET remaining_cents = remaining_cents - ? WHERE debt_id = ?').run(amountCents, debtId);
  }

  pendingSettlements(householdId: string): SettlementRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM settlements s JOIN debts d ON d.debt_id = s.debt_id
          WHERE d.household_id = ? AND s.status = 'pending' ORDER BY s.created_at, s.settlement_id`,
      )
      .all(householdId) as SettlementRow[];
    return rows.map(toSettlement);
  }

  markSettlementApplied(settlementId: string, now: string): void {
    this.db.prepare(`UPDATE settlements SET status = 'applied', applied_at = ? WHERE settlement_id = ?`).run(now, settlementId);
  }

  /** True when a carried-over credit has been reserved against this bill. */
  billHasCredit(billId: string): boolean {
    const rows = this.db.prepare('SELECT applications_json FROM settlements').all() as Array<{ applications_json: string }>;
    return rows.some((r) => (JSON.parse(r.applications_json) as CreditApplication[]).some((a) => a.billId === billId));
  }

  insertDebt(debt: DebtRecord, now: string): void {
    this.db
      .prepare(
        `INSERT INTO debts (debt_id, household_id, debtor_id, creditor_id, original_cents, remaining_cents, source_bill_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        debt.debtId,
        debt.householdId,
        debt.debtorId,
        debt.creditorId,
        debt.originalCents,
        debt.remainingCents,
        debt.sourceBillId,
        now,
      );
  }

  debtsFor(householdId: string, userId: string): DebtRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM debts WHERE household_id = ? AND (debtor_id = ? OR creditor_id = ?) AND remaining_cents > 0
          ORDER BY created_at, debt_id`,
      )
      .all(householdId, userId, userId) as Array<{
      debt_id: string;
      household_id: string;
      debtor_id: string;
      creditor_id: string;
      original_cents: number;
      remaining_cents: number;
      source_bill_id: string;
    }>;
    return rows.map((r) => ({
      debtId: r.debt_id,
      householdId: r.household_id,
      debtorId: r.debtor_id,
      creditorId: r.creditor_id,
      originalCents: r.original_cents,
      remainingCents: r.remaining_cents,
      sourceBillId: r.source_bill_id,
    }));
  }
}
