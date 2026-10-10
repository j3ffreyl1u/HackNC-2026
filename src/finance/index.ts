import { isBankSeeder, type BankingAdapter } from './bank';
import type {
  Command,
  ConversationContext,
  ExecuteResult,
  HouseholdConfig,
  HouseholdSnapshot,
  OutboundMessage,
} from './contracts-local';
import { FinanceEngine } from './engine';
import { FinanceConfigError, NotImplementedError, type Clock, type IdGenerator } from './runtime';
import { LedgerStore } from './store';

export { FinanceConfigError, NotImplementedError };
export type { Clock, IdGenerator };

export interface FinanceDependencies {
  store: LedgerStore;
  bank: BankingAdapter;
  clock: Clock;
  newId: IdGenerator;
}

export interface FinanceService {
  execute(command: Command): Promise<ExecuteResult>;
  reconcile(householdId: string): Promise<void>;
  getSnapshot(householdId: string): Promise<HouseholdSnapshot>;
  pendingMessages(): Promise<OutboundMessage[]>;
  enqueueMessage(message: OutboundMessage): Promise<void>;
  recordDelivery(deliveryId: string, providerMessageId: string): Promise<void>;
  lookupProposal(providerMessageId: string): Promise<{ proposalId: string; proposalVersion: number } | null>;
  advanceDemoCycle(householdId: string, cycleId: string): Promise<void>;
  getConversationContext(actorId: string, spaceId: string, targetMessageId?: string): Promise<ConversationContext>;
  processReminders(householdId: string): Promise<void>;
  bootstrapHousehold(config: HouseholdConfig): Promise<void>;
  seedDemoBanking(config: HouseholdConfig): Promise<HouseholdConfig>;
  claimInbound(eventId: string): Promise<boolean>;
  completeInbound(eventId: string): Promise<void>;
  close(): Promise<void>;
}

const MEMBER_COUNT = 3;
export const MEMBER_STARTING_BALANCE_CENTS = 100_000;
const CYCLE_KEY = 'current_cycle';
const seedKey = (label: string) => `seed_account:${label}`;

function assertUnique(values: string[], what: string): void {
  if (new Set(values).size !== values.length) throw new FinanceConfigError(`${what} must be unique`);
}

function nonEmpty(value: unknown, what: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new FinanceConfigError(`${what} must be a non-empty string`);
}

export function validateHouseholdConfig(config: HouseholdConfig): void {
  nonEmpty(config.householdId, 'householdId');
  nonEmpty(config.groupSpaceId, 'groupSpaceId');
  nonEmpty(config.householdAccountId, 'householdAccountId');
  if (config.members.length !== MEMBER_COUNT) {
    throw new FinanceConfigError(`a household needs exactly ${MEMBER_COUNT} members, got ${config.members.length}`);
  }
  for (const m of config.members) {
    nonEmpty(m.userId, 'member userId');
    nonEmpty(m.providerUserId, `providerUserId for ${m.userId}`);
    nonEmpty(m.bankAccountId, `bankAccountId for ${m.userId}`);
  }
  assertUnique(config.members.map((m) => m.userId), 'member userIds');
  assertUnique(config.members.map((m) => m.providerUserId), 'member providerUserIds');
  if (!config.members.some((m) => m.userId === config.designatedPayerId)) {
    throw new FinanceConfigError('designatedPayerId must be one of the members');
  }
  for (const r of config.recipients) {
    nonEmpty(r.recipientId, 'recipientId');
    nonEmpty(r.bankAccountId, `bankAccountId for recipient ${r.recipientId}`);
  }
  assertUnique(config.recipients.map((r) => r.recipientId), 'recipientIds');
  assertUnique(config.demoCycles.map((c) => c.cycleId), 'demo cycleIds');
  const recipientIds = new Set(config.recipients.map((r) => r.recipientId));
  for (const cycle of config.demoCycles) {
    for (const bill of cycle.bills) {
      if (!Number.isSafeInteger(bill.amountCents) || bill.amountCents <= 0) {
        throw new FinanceConfigError(`bill "${bill.title}" in ${cycle.cycleId} must have a positive integer cent amount`);
      }
      if (!recipientIds.has(bill.recipientId)) {
        throw new FinanceConfigError(`bill "${bill.title}" in ${cycle.cycleId} names unknown recipient ${bill.recipientId}`);
      }
    }
  }
}

export function createFinanceService(dependencies: FinanceDependencies): FinanceService {
  const { store, bank, clock } = dependencies;
  const nowIso = () => clock.now().toISOString();
  const engine = new FinanceEngine(store, clock, dependencies.newId);

  return {
    async execute(command: Command): Promise<ExecuteResult> {
      return engine.execute(command);
    },

    async reconcile(_householdId: string): Promise<void> {
      throw new NotImplementedError('FinanceService.reconcile');
    },

    async getSnapshot(_householdId: string): Promise<HouseholdSnapshot> {
      throw new NotImplementedError('FinanceService.getSnapshot');
    },

    async pendingMessages(): Promise<OutboundMessage[]> {
      return store.pendingOutbox();
    },

    async enqueueMessage(message: OutboundMessage): Promise<void> {
      store.enqueueOutbox(message, nowIso());
    },

    async recordDelivery(deliveryId: string, providerMessageId: string): Promise<void> {
      store.recordDelivery(deliveryId, providerMessageId);
    },

    async lookupProposal(providerMessageId: string) {
      return store.lookupProviderBinding(providerMessageId);
    },

    async advanceDemoCycle(_householdId: string, _cycleId: string): Promise<void> {
      throw new NotImplementedError('FinanceService.advanceDemoCycle');
    },

    async getConversationContext(_actorId: string, _spaceId: string, _targetMessageId?: string) {
      throw new NotImplementedError('FinanceService.getConversationContext');
    },

    async processReminders(_householdId: string): Promise<void> {
      throw new NotImplementedError('FinanceService.processReminders');
    },

    /** Idempotent: refreshes enrollment, never touches ledger state, sets the first demo cycle once. */
    async bootstrapHousehold(config: HouseholdConfig): Promise<void> {
      validateHouseholdConfig(config);
      store.tx(() => {
        store.upsertHousehold(config);
        if (store.getMeta(config.householdId, CYCLE_KEY) === null && config.demoCycles.length > 0) {
          store.setMeta(config.householdId, CYCLE_KEY, config.demoCycles[0].cycleId);
        }
      });
    },

    /**
     * Operator-run only. Reuses any account already recorded for a label and provisions only
     * the missing ones, saving each mapping as soon as it exists so a crash cannot re-create it.
     */
    async seedDemoBanking(config: HouseholdConfig): Promise<HouseholdConfig> {
      if (!isBankSeeder(bank)) {
        throw new FinanceConfigError('the configured bank adapter cannot provision demo accounts');
      }
      const resolve = async (label: string, initialBalanceCents: number): Promise<string> => {
        const existing = store.getMeta(config.householdId, seedKey(label)) ?? undefined;
        const accountId = await bank.provisionAccount({
          label: `${config.householdId}-${label}`,
          initialBalanceCents,
          existingAccountId: existing,
        });
        if (accountId !== existing) store.setMeta(config.householdId, seedKey(label), accountId);
        return accountId;
      };

      const members = [];
      for (const m of config.members) {
        members.push({ ...m, bankAccountId: await resolve(`member-${m.userId}`, MEMBER_STARTING_BALANCE_CENTS) });
      }
      const householdAccountId = await resolve('household', 0);
      const recipients = [];
      for (const r of config.recipients) {
        recipients.push({ ...r, bankAccountId: await resolve(`recipient-${r.recipientId}`, 0) });
      }
      return { ...config, householdAccountId, members, recipients };
    },

    async claimInbound(eventId: string): Promise<boolean> {
      return store.claimInbound(eventId, nowIso());
    },

    async completeInbound(eventId: string): Promise<void> {
      store.completeInbound(eventId, nowIso());
    },

    async close(): Promise<void> {
      store.close();
    },
  };
}
