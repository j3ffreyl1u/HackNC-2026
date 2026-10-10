import Database from 'better-sqlite3';
import type {
  OutboundMessage,
  PublicTripSnapshot,
  Repository,
  TripEnrollment,
  TripId,
  TripState,
} from '../contracts/index.js';

type SqliteDatabase = Database.Database;
type CommitInput = Parameters<Repository['commitEvent']>[0];

/** SQLite-backed trip state, revision history, event dedupe, and durable message outbox. */
export class SqliteTripRepository implements Repository {
  private constructor(private readonly db: SqliteDatabase) {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS trip_enrollments (
        trip_id TEXT PRIMARY KEY,
        group_space_id TEXT NOT NULL,
        participants_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trips (
        trip_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trip_revisions (
        trip_id TEXT NOT NULL REFERENCES trips(trip_id),
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        PRIMARY KEY (trip_id, revision)
      );
      CREATE TABLE IF NOT EXISTS trip_events (
        event_id TEXT PRIMARY KEY,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_outbox (
        delivery_id TEXT PRIMARY KEY,
        message_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
        provider_message_id TEXT,
        queued_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS message_outbox_pending ON message_outbox(status, queued_at);
      CREATE TABLE IF NOT EXISTS message_deliveries (
        delivery_id TEXT NOT NULL REFERENCES message_outbox(delivery_id),
        provider_message_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY (delivery_id, provider_message_id)
      );
      CREATE TABLE IF NOT EXISTS proposal_message_bindings (
        provider_message_id TEXT PRIMARY KEY REFERENCES message_deliveries(provider_message_id),
        candidate_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        delivery_id TEXT NOT NULL REFERENCES message_outbox(delivery_id)
      );
    `);
    const enrollmentColumns = db.prepare('PRAGMA table_info(trip_enrollments)').all() as Array<{ name: string }>;
    if (!enrollmentColumns.some(column => column.name === 'chat_mode')) db.exec("ALTER TABLE trip_enrollments ADD COLUMN chat_mode TEXT NOT NULL DEFAULT 'group'");
    // Preserve reaction lookup for deliveries written by the original single-receipt schema.
    const legacyDeliveries = db.prepare("SELECT delivery_id, provider_message_id, message_json FROM message_outbox WHERE status = 'delivered' AND provider_message_id IS NOT NULL").all() as
      Array<{ delivery_id: string; provider_message_id: string; message_json: string }>;
    db.transaction(() => {
      const receipt = db.prepare('INSERT OR IGNORE INTO message_deliveries (delivery_id, provider_message_id) VALUES (?, ?)');
      const binding = db.prepare('INSERT OR IGNORE INTO proposal_message_bindings (provider_message_id, candidate_id, revision, delivery_id) VALUES (?, ?, ?, ?)');
      for (const row of legacyDeliveries) {
        receipt.run(row.delivery_id, row.provider_message_id);
        const proposalRef = (JSON.parse(row.message_json) as OutboundMessage).proposalRef;
        if (proposalRef) binding.run(row.provider_message_id, proposalRef.candidateId, proposalRef.revision, row.delivery_id);
      }
    })();
  }

  static open(path: string): SqliteTripRepository {
    return new SqliteTripRepository(new Database(path));
  }

  close(): void {
    this.db.close();
  }

  async bootstrapTrip(enrollment: TripEnrollment, initialState: TripState): Promise<void> {
    validateEnrollment(enrollment, initialState);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT group_space_id, participants_json, chat_mode FROM trip_enrollments WHERE trip_id = ?').get(enrollment.tripId) as
        | { group_space_id: string; participants_json: string; chat_mode: string }
        | undefined;
      if (existing) {
        const stored = JSON.parse(existing.participants_json) as TripEnrollment['participants'];
        const sameMembers = stored.length === enrollment.participants.length && stored.every((p) => {
          const current = enrollment.participants.find((member) => member.memberId === p.memberId);
          return current?.providerUserId === p.providerUserId;
        });
        if (existing.group_space_id !== enrollment.groupSpaceId || !sameMembers || existing.chat_mode !== (enrollment.mode ?? 'group')) {
          throw new Error(`Enrollment identity for trip ${enrollment.tripId} cannot be changed by bootstrap.`);
        }
        return;
      }
      this.db.prepare('INSERT INTO trip_enrollments (trip_id, group_space_id, participants_json, chat_mode) VALUES (?, ?, ?, ?)')
        .run(enrollment.tripId, enrollment.groupSpaceId, JSON.stringify(enrollment.participants), enrollment.mode ?? 'group');
      const stateJson = JSON.stringify(initialState);
      this.db.prepare('INSERT INTO trips (trip_id, revision, state_json, updated_at) VALUES (?, ?, ?, ?)')
        .run(initialState.tripId, initialState.revision, stateJson, now);
      this.db.prepare('INSERT INTO trip_revisions (trip_id, revision, state_json, saved_at) VALUES (?, ?, ?, ?)')
        .run(initialState.tripId, initialState.revision, stateJson, now);
    })();
  }

  async getEnrollment(tripId: TripId): Promise<TripEnrollment | null> {
    const row = this.db.prepare('SELECT group_space_id, participants_json, chat_mode FROM trip_enrollments WHERE trip_id = ?').get(tripId) as
      | { group_space_id: string; participants_json: string; chat_mode: 'group' | 'direct' }
      | undefined;
    return row
      ? { tripId, groupSpaceId: row.group_space_id, ...(row.chat_mode === 'direct' ? { mode: 'direct' as const } : {}), participants: JSON.parse(row.participants_json) as TripEnrollment['participants'] }
      : null;
  }

  async loadTrip(tripId: TripId): Promise<TripState | null> {
    const row = this.db.prepare('SELECT state_json FROM trips WHERE trip_id = ?').get(tripId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as TripState : null;
  }

  async saveTripIfRevision(state: TripState, expectedRevision: number): Promise<boolean> {
    return this.saveState(state, expectedRevision, new Date().toISOString());
  }

  async recordEvent(eventId: string): Promise<boolean> {
    const result = this.db.prepare('INSERT OR IGNORE INTO trip_events (event_id, recorded_at) VALUES (?, ?)')
      .run(eventId, new Date().toISOString());
    return result.changes === 1;
  }

  async hasProcessedEvent(eventId: string): Promise<boolean> {
    return Boolean(this.db.prepare('SELECT 1 FROM trip_events WHERE event_id = ?').get(eventId));
  }

  async commitEvent(input: CommitInput): Promise<'committed' | 'duplicate' | 'stale'> {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM trip_events WHERE event_id = ?').get(input.eventId)) return 'duplicate';
      const current = this.db.prepare('SELECT revision FROM trips WHERE trip_id = ?').get(input.state.tripId) as { revision: number } | undefined;
      if (!current || current.revision !== input.expectedRevision) return 'stale';
      if (!Number.isSafeInteger(input.state.revision) || input.state.revision < input.expectedRevision) {
        throw new Error('A committed state must retain or advance the current revision.');
      }
      if (input.state.revision !== input.expectedRevision) {
        const updated = this.db.prepare('UPDATE trips SET revision = ?, state_json = ?, updated_at = ? WHERE trip_id = ? AND revision = ?')
          .run(input.state.revision, JSON.stringify(input.state), now, input.state.tripId, input.expectedRevision);
        if (updated.changes !== 1) return 'stale';
        this.db.prepare('INSERT INTO trip_revisions (trip_id, revision, state_json, saved_at) VALUES (?, ?, ?, ?)')
          .run(input.state.tripId, input.state.revision, JSON.stringify(input.state), now);
      } else if ((this.db.prepare('SELECT state_json FROM trips WHERE trip_id = ?').get(input.state.tripId) as { state_json: string }).state_json !== JSON.stringify(input.state)) {
        this.db.prepare('UPDATE trips SET state_json = ?, updated_at = ? WHERE trip_id = ? AND revision = ?')
          .run(JSON.stringify(input.state), now, input.state.tripId, input.expectedRevision);
        this.db.prepare(`
          INSERT INTO trip_revisions (trip_id, revision, state_json, saved_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(trip_id, revision) DO UPDATE SET state_json = excluded.state_json, saved_at = excluded.saved_at
        `).run(input.state.tripId, input.state.revision, JSON.stringify(input.state), now);
      }
      this.insertMessages(input.messages, now);
      this.db.prepare('INSERT INTO trip_events (event_id, recorded_at) VALUES (?, ?)').run(input.eventId, now);
      return 'committed';
    })();
  }

  async enqueueMessages(messages: OutboundMessage[]): Promise<void> {
    this.db.transaction(() => this.insertMessages(messages, new Date().toISOString()))();
  }

  async pendingMessages(): Promise<OutboundMessage[]> {
    const rows = this.db.prepare("SELECT message_json FROM message_outbox WHERE status = 'pending' ORDER BY queued_at, delivery_id").all() as
      Array<{ message_json: string }>;
    return rows.map((row) => JSON.parse(row.message_json) as OutboundMessage);
  }

  async recordDelivery(deliveryId: string, providerMessageIds: string[]): Promise<void> {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT status, provider_message_id, message_json FROM message_outbox WHERE delivery_id = ?').get(deliveryId) as
        | { status: string; provider_message_id: string | null; message_json: string }
        | undefined;
      if (!row) throw new Error(`Unknown message delivery ${deliveryId}.`);
      if (new Set(providerMessageIds).size !== providerMessageIds.length || providerMessageIds.some((id) => !id.trim())) {
        throw new Error(`Delivery ${deliveryId} contains an empty or duplicate provider message ID.`);
      }
      const prior = this.db.prepare('SELECT provider_message_id FROM message_deliveries WHERE delivery_id = ? ORDER BY rowid').all(deliveryId) as Array<{ provider_message_id: string }>;
      if (row.status === 'delivered') {
        const saved = prior.map(({ provider_message_id }) => provider_message_id);
        if (JSON.stringify(saved) !== JSON.stringify(providerMessageIds)) throw new Error(`Delivery ${deliveryId} was recorded with different provider message IDs.`);
        return;
      }
      const message = JSON.parse(row.message_json) as OutboundMessage;
      const insertReceipt = this.db.prepare('INSERT INTO message_deliveries (delivery_id, provider_message_id) VALUES (?, ?)');
      const insertBinding = this.db.prepare('INSERT INTO proposal_message_bindings (provider_message_id, candidate_id, revision, delivery_id) VALUES (?, ?, ?, ?)');
      for (const providerMessageId of providerMessageIds) {
        insertReceipt.run(deliveryId, providerMessageId);
        if (message.proposalRef) {
          insertBinding.run(providerMessageId, message.proposalRef.candidateId, message.proposalRef.revision, deliveryId);
        }
      }
      this.db.prepare("UPDATE message_outbox SET status = 'delivered', provider_message_id = ?, delivered_at = ? WHERE delivery_id = ?")
        .run(providerMessageIds[0] ?? null, new Date().toISOString(), deliveryId);
    })();
  }

  async lookupProposal(providerMessageId: string): Promise<{ candidateId: string; revision: number; kind?: 'select' | 'accept' } | null> {
    const row = this.db.prepare('SELECT candidate_id, revision FROM proposal_message_bindings WHERE provider_message_id = ?').get(providerMessageId) as
      | { candidate_id: string; revision: number }
      | undefined;
    if (!row) return null;
    const message = this.db.prepare('SELECT o.message_json FROM message_outbox o JOIN proposal_message_bindings b ON b.delivery_id = o.delivery_id WHERE b.provider_message_id = ?').get(providerMessageId) as { message_json: string };
    const kind = (JSON.parse(message.message_json) as OutboundMessage).proposalRef?.kind;
    return { candidateId: row.candidate_id, revision: row.revision, ...(kind ? { kind } : {}) };
  }

  async getPublicSnapshot(tripId: string): Promise<PublicTripSnapshot | null> {
    const [state, enrollment] = await Promise.all([this.loadTrip(tripId), this.getEnrollment(tripId)]);
    if (!state || !enrollment) return null;
    const candidates = state.candidates.map(candidate => ({ ...candidate, feasibility: {
      feasible: candidate.feasibility.feasible,
      unknownEssentials: candidate.feasibility.unknownEssentials,
      violatedConstraints: candidate.feasibility.violatedConstraints.map(v => v.constraint === 'budget'
        ? { constraint: 'budget', explanation: "The upper estimate is over at least one person's limit." }
        : { constraint: v.constraint, explanation: v.explanation }),
    } }));
    const selectedCandidate = candidates.find((candidate) => candidate.candidateId === state.selectedCandidateId);
    return {
      tripId: state.tripId,
      revision: state.revision,
      status: state.status,
      participants: enrollment.participants.map(({ memberId, displayName }) => ({ memberId, displayName })),
      ...(selectedCandidate ? { selectedCandidate } : {}),
      candidates,
      acceptances: state.acceptances,
      fundingStatus: state.fundingStatus,
    };
  }

  private saveState(state: TripState, expectedRevision: number, now: string): boolean {
    if (state.revision !== expectedRevision + 1) throw new Error('Saved trip revisions must advance by exactly one.');
    return this.db.transaction(() => {
      const updated = this.db.prepare('UPDATE trips SET revision = ?, state_json = ?, updated_at = ? WHERE trip_id = ? AND revision = ?')
        .run(state.revision, JSON.stringify(state), now, state.tripId, expectedRevision);
      if (updated.changes !== 1) return false;
      this.db.prepare('INSERT INTO trip_revisions (trip_id, revision, state_json, saved_at) VALUES (?, ?, ?, ?)')
        .run(state.tripId, state.revision, JSON.stringify(state), now);
      return true;
    })();
  }

  private insertMessages(messages: OutboundMessage[], now: string): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO message_outbox (delivery_id, message_json, status, queued_at) VALUES (?, ?, \'pending\', ?)');
    const select = this.db.prepare('SELECT message_json FROM message_outbox WHERE delivery_id = ?');
    for (const message of messages) {
      const json = JSON.stringify(message);
      insert.run(message.deliveryId, json, now);
      const stored = select.get(message.deliveryId) as { message_json: string };
      if (stored.message_json !== json) throw new Error(`Delivery ID ${message.deliveryId} was reused for a different message.`);
    }
  }
}

function validateEnrollment(enrollment: TripEnrollment, state: TripState): void {
  if (!enrollment.tripId || enrollment.tripId !== state.tripId || !enrollment.groupSpaceId) {
    throw new Error('Enrollment and initial trip state must share a non-empty trip ID and group space.');
  }
  if (enrollment.participants.length === 0) throw new Error('A trip must have at least one enrolled participant.');
  const members = new Set<string>();
  const providers = new Set<string>();
  for (const participant of enrollment.participants) {
    if (!participant.memberId || !participant.displayName || !participant.providerUserId) throw new Error('Enrolled participants need IDs, display names, and provider identities.');
    if (members.has(participant.memberId) || providers.has(participant.providerUserId)) throw new Error('Enrolled participant identities must be unique.');
    members.add(participant.memberId);
    providers.add(participant.providerUserId);
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('Initial trip revision must be a non-negative integer.');
}
