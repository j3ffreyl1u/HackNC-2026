import Database from 'better-sqlite3';
import type { HouseholdConfig, OutboundMessage } from '../contracts/index.js';

// SQLite ledger owned by B. Synchronous (better-sqlite3), so every command's state and
// outbox changes can share one local transaction via `tx`.

const MIGRATIONS: string[] = [
  `
  CREATE TABLE households (
    household_id TEXT PRIMARY KEY,
    group_space_id TEXT NOT NULL,
    designated_payer_id TEXT NOT NULL,
    household_account_id TEXT NOT NULL,
    config_json TEXT NOT NULL
  );
  CREATE TABLE members (
    household_id TEXT NOT NULL REFERENCES households(household_id),
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    bank_account_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (household_id, user_id)
  );
  CREATE TABLE recipients (
    household_id TEXT NOT NULL REFERENCES households(household_id),
    recipient_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    bank_account_id TEXT NOT NULL,
    PRIMARY KEY (household_id, recipient_id)
  );
  CREATE TABLE meta (
    household_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (household_id, key)
  );

  CREATE TABLE bills (
    bill_id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(household_id),
    cycle_id TEXT NOT NULL,
    title TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    due_date TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft','collecting','ready','paid','failed')),
    created_at TEXT NOT NULL
  );
  -- What each member is asked to contribute for a bill (the logical beneficiary).
  CREATE TABLE obligations (
    bill_id TEXT NOT NULL REFERENCES bills(bill_id),
    user_id TEXT NOT NULL,
    agreed_cents INTEGER NOT NULL CHECK (agreed_cents >= 0),
    PRIMARY KEY (bill_id, user_id)
  );
  -- Confirmed money, attributed to the actual payer and the logical beneficiary.
  CREATE TABLE allocations (
    allocation_id TEXT PRIMARY KEY,
    bill_id TEXT NOT NULL REFERENCES bills(bill_id),
    payer_id TEXT NOT NULL,
    beneficiary_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('own','coverage','credit_settlement')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE proposals (
    proposal_id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(household_id),
    bill_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('contribution','coverage','bill_payment')),
    version INTEGER NOT NULL CHECK (version >= 1),
    status TEXT NOT NULL CHECK (status IN
      ('proposed','approved','submitted','pending','unknown','confirmed','failed','declined','superseded')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    source_account_id TEXT NOT NULL,
    destination_account_id TEXT NOT NULL,
    required_actor_ids TEXT NOT NULL,
    allocation_json TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE approvals (
    proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
    proposal_version INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    PRIMARY KEY (proposal_id, proposal_version, actor_id)
  );
  CREATE TABLE provider_message_bindings (
    provider_message_id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
    proposal_version INTEGER NOT NULL
  );

  CREATE TABLE coverage_requests (
    request_id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(household_id),
    bill_id TEXT NOT NULL,
    debtor_id TEXT NOT NULL,
    volunteer_id TEXT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    status TEXT NOT NULL CHECK (status IN
      ('awaiting_share_consent','closed','open','awaiting_approvals','funded','failed')),
    proposal_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE debts (
    debt_id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(household_id),
    debtor_id TEXT NOT NULL,
    creditor_id TEXT NOT NULL,
    original_cents INTEGER NOT NULL CHECK (original_cents > 0),
    remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0 AND remaining_cents <= original_cents),
    source_bill_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  -- One settlement per debt in this single-settlement MVP.
  CREATE TABLE settlements (
    settlement_id TEXT PRIMARY KEY,
    debt_id TEXT NOT NULL UNIQUE REFERENCES debts(debt_id),
    cycle_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    status TEXT NOT NULL CHECK (status IN ('pending','applied')),
    created_at TEXT NOT NULL,
    applied_at TEXT
  );

  CREATE TABLE bank_operations (
    operation_id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(household_id),
    proposal_id TEXT NOT NULL,
    proposal_version INTEGER NOT NULL,
    from_account_id TEXT NOT NULL,
    to_account_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN
      ('prepared','submitted','pending','unknown','confirmed','failed')),
    provider_transaction_id TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE processed_commands (
    command_id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    result_kind TEXT NOT NULL,
    processed_at TEXT NOT NULL
  );
  CREATE TABLE inbound_events (
    event_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('received','processed')),
    received_at TEXT NOT NULL,
    processed_at TEXT
  );
  CREATE TABLE outbox (
    delivery_id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    audience_json TEXT NOT NULL,
    text TEXT NOT NULL,
    proposal_id TEXT,
    proposal_version INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending','sent','uncertain')),
    provider_message_id TEXT,
    created_at TEXT NOT NULL,
    sequence INTEGER NOT NULL
  );
  CREATE INDEX idx_outbox_status ON outbox(status, sequence);
  CREATE INDEX idx_bank_operations_status ON bank_operations(status);
  `,
  // v2: remember which contribution proposals a coverage agreement replaced, so a declined
  // agreement can reopen them instead of leaving members with nothing to approve.
  `ALTER TABLE coverage_requests ADD COLUMN superseded_json TEXT NOT NULL DEFAULT '[]';`,
];

export type BankOperationStatus = 'prepared' | 'submitted' | 'pending' | 'unknown' | 'confirmed' | 'failed';

export interface BankOperationRecord {
  operationId: string;
  householdId: string;
  proposalId: string;
  proposalVersion: number;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  description: string;
  status: BankOperationStatus;
  providerTransactionId?: string;
  reason?: string;
}

interface BankOperationRow {
  operation_id: string;
  household_id: string;
  proposal_id: string;
  proposal_version: number;
  from_account_id: string;
  to_account_id: string;
  amount_cents: number;
  description: string;
  status: BankOperationStatus;
  provider_transaction_id: string | null;
  reason: string | null;
}

function toOperation(row: BankOperationRow): BankOperationRecord {
  return {
    operationId: row.operation_id,
    householdId: row.household_id,
    proposalId: row.proposal_id,
    proposalVersion: row.proposal_version,
    fromAccountId: row.from_account_id,
    toAccountId: row.to_account_id,
    amountCents: row.amount_cents,
    description: row.description,
    status: row.status,
    ...(row.provider_transaction_id ? { providerTransactionId: row.provider_transaction_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

/** Operations that may still have moved, or may yet move, money. */
const UNRESOLVED_OPERATION_STATUSES = ['prepared', 'submitted', 'pending', 'unknown'] as const;

export class LedgerStore {
  /** B-internal: the engine and tests may run their own statements inside `tx`. */
  readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(path: string): LedgerStore {
    const db = new Database(path);
    if (path !== ':memory:') db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const store = new LedgerStore(db);
    store.migrate();
    return store;
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  /** Run `fn` in one atomic transaction; it rolls back if `fn` throws. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  private migrate(): void {
    const current = this.schemaVersion();
    if (current > MIGRATIONS.length) {
      throw new Error(`ledger schema v${current} is newer than this build supports (v${MIGRATIONS.length})`);
    }
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.pragma(`user_version = ${version + 1}`);
      });
    }
  }

  // ---- households, enrollment -------------------------------------------------

  /** Idempotent: replaces enrollment rows for the household, never touching ledger state. */
  upsertHousehold(config: HouseholdConfig): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO households (household_id, group_space_id, designated_payer_id, household_account_id, config_json)
           VALUES (@householdId, @groupSpaceId, @designatedPayerId, @householdAccountId, @configJson)
           ON CONFLICT(household_id) DO UPDATE SET
             group_space_id = excluded.group_space_id,
             designated_payer_id = excluded.designated_payer_id,
             household_account_id = excluded.household_account_id,
             config_json = excluded.config_json`,
        )
        .run({
          householdId: config.householdId,
          groupSpaceId: config.groupSpaceId,
          designatedPayerId: config.designatedPayerId,
          householdAccountId: config.householdAccountId,
          configJson: JSON.stringify(config),
        });
      this.db.prepare('DELETE FROM members WHERE household_id = ?').run(config.householdId);
      this.db.prepare('DELETE FROM recipients WHERE household_id = ?').run(config.householdId);
      const addMember = this.db.prepare(
        `INSERT INTO members (household_id, user_id, display_name, provider_user_id, bank_account_id, position)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      config.members.forEach((m, index) =>
        addMember.run(config.householdId, m.userId, m.displayName, m.providerUserId, m.bankAccountId, index),
      );
      const addRecipient = this.db.prepare(
        'INSERT INTO recipients (household_id, recipient_id, display_name, bank_account_id) VALUES (?, ?, ?, ?)',
      );
      for (const r of config.recipients) addRecipient.run(config.householdId, r.recipientId, r.displayName, r.bankAccountId);
    });
  }

  getHouseholdConfig(householdId: string): HouseholdConfig | null {
    const row = this.db.prepare('SELECT config_json FROM households WHERE household_id = ?').get(householdId) as
      | { config_json: string }
      | undefined;
    return row ? (JSON.parse(row.config_json) as HouseholdConfig) : null;
  }

  /** Member IDs in stable configured order, used for remainder-cent assignment. */
  memberIds(householdId: string): string[] {
    const rows = this.db
      .prepare('SELECT user_id FROM members WHERE household_id = ? ORDER BY position')
      .all(householdId) as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }

  getMeta(householdId: string, key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE household_id = ? AND key = ?').get(householdId, key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setMeta(householdId: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (household_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(household_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(householdId, key, value);
  }

  // ---- inbound events and commands -------------------------------------------

  /** False only for an already-processed event; an interrupted `received` event stays claimable. */
  claimInbound(eventId: string, now: string): boolean {
    return this.tx(() => {
      const row = this.db.prepare('SELECT status FROM inbound_events WHERE event_id = ?').get(eventId) as
        | { status: 'received' | 'processed' }
        | undefined;
      if (row?.status === 'processed') return false;
      if (!row) {
        this.db
          .prepare("INSERT INTO inbound_events (event_id, status, received_at) VALUES (?, 'received', ?)")
          .run(eventId, now);
      }
      return true;
    });
  }

  completeInbound(eventId: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO inbound_events (event_id, status, received_at, processed_at) VALUES (?, 'processed', ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET status = 'processed', processed_at = excluded.processed_at`,
      )
      .run(eventId, now, now);
  }

  /** True if this is the first time the command is recorded; false for a duplicate. */
  markCommandProcessed(commandId: string, householdId: string, resultKind: string, now: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_commands (command_id, household_id, result_kind, processed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(commandId, householdId, resultKind, now);
    return result.changes === 1;
  }

  isCommandProcessed(commandId: string): boolean {
    return this.db.prepare('SELECT 1 FROM processed_commands WHERE command_id = ?').get(commandId) !== undefined;
  }

  // ---- approvals and settlements ---------------------------------------------

  /** True if newly recorded; false if this actor already approved this exact version. */
  recordApproval(proposalId: string, proposalVersion: number, actorId: string, now: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO approvals (proposal_id, proposal_version, actor_id, approved_at) VALUES (?, ?, ?, ?)`,
      )
      .run(proposalId, proposalVersion, actorId, now);
    return result.changes === 1;
  }

  approvalsFor(proposalId: string, proposalVersion: number): string[] {
    const rows = this.db
      .prepare('SELECT actor_id FROM approvals WHERE proposal_id = ? AND proposal_version = ? ORDER BY actor_id')
      .all(proposalId, proposalVersion) as Array<{ actor_id: string }>;
    return rows.map((r) => r.actor_id);
  }

  /** True if a settlement was created; false if this debt already has one. */
  createSettlement(
    settlementId: string,
    debtId: string,
    cycleId: string,
    amountCents: number,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO settlements (settlement_id, debt_id, cycle_id, amount_cents, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(settlementId, debtId, cycleId, amountCents, now);
    return result.changes === 1;
  }

  // ---- bank operations -------------------------------------------------------

  /** Persist before sending to the bank. Throws on a duplicate operationId. */
  insertBankOperation(op: Omit<BankOperationRecord, 'status'>, now: string): void {
    this.db
      .prepare(
        `INSERT INTO bank_operations
           (operation_id, household_id, proposal_id, proposal_version, from_account_id, to_account_id,
            amount_cents, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      )
      .run(
        op.operationId,
        op.householdId,
        op.proposalId,
        op.proposalVersion,
        op.fromAccountId,
        op.toAccountId,
        op.amountCents,
        op.description,
        now,
        now,
      );
  }

  updateBankOperation(
    operationId: string,
    update: { status: BankOperationStatus; providerTransactionId?: string; reason?: string },
    now: string,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE bank_operations
            SET status = ?,
                provider_transaction_id = COALESCE(?, provider_transaction_id),
                reason = ?,
                updated_at = ?
          WHERE operation_id = ?`,
      )
      .run(update.status, update.providerTransactionId ?? null, update.reason ?? null, now, operationId);
    if (result.changes !== 1) throw new Error(`unknown bank operation ${operationId}`);
  }

  /**
   * Atomically move a never-sent operation to `submitted` just before the bank call.
   * Returns false if someone else already claimed it or it was cancelled, so it is sent at most once.
   */
  claimOperationForSubmission(operationId: string, now: string): boolean {
    const result = this.db
      .prepare(`UPDATE bank_operations SET status = 'submitted', updated_at = ? WHERE operation_id = ? AND status = 'prepared'`)
      .run(now, operationId);
    return result.changes === 1;
  }

  getBankOperation(operationId: string): BankOperationRecord | null {
    const row = this.db.prepare('SELECT * FROM bank_operations WHERE operation_id = ?').get(operationId) as
      | BankOperationRow
      | undefined;
    return row ? toOperation(row) : null;
  }

  /** Prepared, submitted, pending and unknown operations, oldest first. */
  unresolvedBankOperations(householdId?: string): BankOperationRecord[] {
    const placeholders = UNRESOLVED_OPERATION_STATUSES.map(() => '?').join(',');
    const rows = (
      householdId === undefined
        ? this.db
            .prepare(`SELECT * FROM bank_operations WHERE status IN (${placeholders}) ORDER BY created_at, operation_id`)
            .all(...UNRESOLVED_OPERATION_STATUSES)
        : this.db
            .prepare(
              `SELECT * FROM bank_operations WHERE household_id = ? AND status IN (${placeholders})
               ORDER BY created_at, operation_id`,
            )
            .all(householdId, ...UNRESOLVED_OPERATION_STATUSES)
    ) as BankOperationRow[];
    return rows.map(toOperation);
  }

  // ---- outbox and provider-message bindings ----------------------------------

  /** True if queued; false if this deliveryId already exists (a retry never double-queues). */
  enqueueOutbox(message: OutboundMessage, now: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox
           (delivery_id, household_id, audience_json, text, proposal_id, proposal_version, status, created_at, sequence)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?,
                 COALESCE((SELECT MAX(sequence) FROM outbox), 0) + 1)`,
      )
      .run(
        message.deliveryId,
        message.householdId,
        JSON.stringify(message.audience),
        message.text,
        message.proposalRef?.proposalId ?? null,
        message.proposalRef?.proposalVersion ?? null,
        now,
      );
    return result.changes === 1;
  }

  /** Messages not yet delivered, in enqueue order. `uncertain` ones are excluded until inspected. */
  pendingOutbox(): OutboundMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM outbox WHERE status = 'pending' ORDER BY sequence`)
      .all() as Array<{
      delivery_id: string;
      household_id: string;
      audience_json: string;
      text: string;
      proposal_id: string | null;
      proposal_version: number | null;
    }>;
    return rows.map((row) => ({
      deliveryId: row.delivery_id,
      householdId: row.household_id,
      audience: JSON.parse(row.audience_json) as OutboundMessage['audience'],
      text: row.text,
      ...(row.proposal_id !== null && row.proposal_version !== null
        ? { proposalRef: { proposalId: row.proposal_id, proposalVersion: row.proposal_version } }
        : {}),
    }));
  }

  /** Mark delivered and, for proposal messages, bind the provider message ID for later reactions. */
  recordDelivery(deliveryId: string, providerMessageId: string): void {
    this.tx(() => {
      const row = this.db
        .prepare('SELECT proposal_id, proposal_version, status FROM outbox WHERE delivery_id = ?')
        .get(deliveryId) as
        | { proposal_id: string | null; proposal_version: number | null; status: string }
        | undefined;
      if (!row) throw new Error(`unknown delivery ${deliveryId}`);
      this.db
        .prepare(`UPDATE outbox SET status = 'sent', provider_message_id = ? WHERE delivery_id = ?`)
        .run(providerMessageId, deliveryId);
      if (row.proposal_id !== null && row.proposal_version !== null) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO provider_message_bindings (provider_message_id, proposal_id, proposal_version)
             VALUES (?, ?, ?)`,
          )
          .run(providerMessageId, row.proposal_id, row.proposal_version);
      }
    });
  }

  /** A send may have succeeded without its receipt being recorded; hold it for inspection. */
  markDeliveryUncertain(deliveryId: string): void {
    this.db.prepare(`UPDATE outbox SET status = 'uncertain' WHERE delivery_id = ? AND status = 'pending'`).run(deliveryId);
  }

  lookupProviderBinding(providerMessageId: string): { proposalId: string; proposalVersion: number } | null {
    const row = this.db
      .prepare('SELECT proposal_id, proposal_version FROM provider_message_bindings WHERE provider_message_id = ?')
      .get(providerMessageId) as { proposal_id: string; proposal_version: number } | undefined;
    return row ? { proposalId: row.proposal_id, proposalVersion: row.proposal_version } : null;
  }
}
