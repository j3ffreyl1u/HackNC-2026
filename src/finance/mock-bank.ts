import type { BankSeeder, BankTransferResult, BankingAdapter, SubmitTransferInput } from './bank.js';

/** What the next submitTransfer call should do, consumed in FIFO order. */
export type InjectedBehavior =
  /** Provider rejects the transfer; nothing moves. */
  | 'fail'
  /** Provider accepts but has not settled; funds move only on settle(). */
  | 'pending'
  /** Provider answers with an unknown status (e.g. ambiguous response); transfer is recorded as pending. */
  | 'unknown-response'
  /** Network error before the provider saw the request; nothing moves. */
  | 'throw-before'
  /** Provider executed the transfer but the response was lost; call throws. */
  | 'throw-after';

interface StoredTransfer {
  providerTransactionId: string;
  operationId: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  status: 'confirmed' | 'pending' | 'failed';
  reason?: string;
}

export interface MockBankOptions {
  balances?: Record<string, number>;
  /** When true, a repeated operationId returns the original transfer. Default false, like a provider with no idempotency. */
  idempotentByOperationId?: boolean;
  /** When false, findTransfer returns `unknown` for everything. Default true. */
  supportsFindTransfer?: boolean;
}

export class MockBank implements BankingAdapter, BankSeeder {
  private readonly balances = new Map<string, number>();
  private readonly transfers: StoredTransfer[] = [];
  private readonly behaviors: InjectedBehavior[] = [];
  private nextId = 1;
  private readonly idempotent: boolean;
  private supportsFind: boolean;

  /** Every submitTransfer call, including failed and repeated ones. */
  readonly submitCalls: SubmitTransferInput[] = [];

  constructor(options: MockBankOptions = {}) {
    for (const [id, cents] of Object.entries(options.balances ?? {})) this.balances.set(id, cents);
    this.idempotent = options.idempotentByOperationId ?? false;
    this.supportsFind = options.supportsFindTransfer ?? true;
  }

  setBalance(accountId: string, cents: number): void {
    this.balances.set(accountId, cents);
  }

  setSupportsFindTransfer(value: boolean): void {
    this.supportsFind = value;
  }

  /** Queue behavior for the next submitTransfer call(s). */
  inject(...behaviors: InjectedBehavior[]): void {
    this.behaviors.push(...behaviors);
  }

  /** Number of transfers the provider actually holds, in any state. */
  get transferCount(): number {
    return this.transfers.length;
  }

  /** Settle a pending transfer, as the provider would eventually. */
  settle(providerTransactionId: string, outcome: 'confirmed' | 'failed' = 'confirmed'): void {
    const transfer = this.requireTransfer(providerTransactionId);
    if (transfer.status !== 'pending') throw new Error(`transfer ${providerTransactionId} is not pending`);
    if (outcome === 'confirmed') {
      const failure = this.debitCredit(transfer);
      if (failure) {
        transfer.status = 'failed';
        transfer.reason = failure;
        return;
      }
      transfer.status = 'confirmed';
    } else {
      transfer.status = 'failed';
      transfer.reason = 'declined by provider';
    }
  }

  /**
   * Deterministic account IDs per label. An account the bank already holds keeps its balance;
   * only an unknown account is created with the starting balance.
   */
  async provisionAccount(input: {
    label: string;
    initialBalanceCents: number;
    existingAccountId?: string;
  }): Promise<string> {
    const accountId = input.existingAccountId ?? `mock-${input.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    if (!this.balances.has(accountId)) this.balances.set(accountId, input.initialBalanceCents);
    return accountId;
  }

  async getBalance(accountId: string): Promise<number> {
    return this.balances.get(accountId) ?? 0;
  }

  async submitTransfer(input: SubmitTransferInput): Promise<BankTransferResult> {
    this.submitCalls.push({ ...input });
    const behavior = this.behaviors.shift();

    if (behavior === 'throw-before') throw new Error('network error: connection reset');

    if (this.idempotent) {
      const existing = this.transfers.find((t) => t.operationId === input.operationId);
      if (existing) return this.toResult(existing);
    }

    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      return { status: 'failed', reason: 'invalid amount' };
    }

    const transfer: StoredTransfer = {
      providerTransactionId: `mock-tx-${this.nextId++}`,
      operationId: input.operationId,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountCents: input.amountCents,
      status: 'pending',
    };

    if (behavior === 'fail') {
      transfer.status = 'failed';
      transfer.reason = 'rejected by provider';
      this.transfers.push(transfer);
      return this.toResult(transfer);
    }

    this.transfers.push(transfer);

    if (behavior === 'pending' || behavior === 'unknown-response') {
      return behavior === 'pending'
        ? this.toResult(transfer)
        : { status: 'unknown', reason: 'ambiguous provider response' };
    }

    const failure = this.debitCredit(transfer);
    if (failure) {
      transfer.status = 'failed';
      transfer.reason = failure;
    } else {
      transfer.status = 'confirmed';
    }

    if (behavior === 'throw-after') throw new Error('timeout waiting for provider response');
    return this.toResult(transfer);
  }

  async getTransfer(providerTransactionId: string): Promise<BankTransferResult> {
    const transfer = this.transfers.find((t) => t.providerTransactionId === providerTransactionId);
    if (!transfer) return { status: 'unknown', reason: 'no such transaction' };
    return this.toResult(transfer);
  }

  async findTransfer(operationId: string, fromAccountId: string): Promise<BankTransferResult | null> {
    if (!this.supportsFind) return { status: 'unknown', reason: 'provider cannot look up by operation' };
    const transfer = this.transfers.find((t) => t.operationId === operationId && t.fromAccountId === fromAccountId);
    return transfer ? this.toResult(transfer) : null;
  }

  private requireTransfer(providerTransactionId: string): StoredTransfer {
    const transfer = this.transfers.find((t) => t.providerTransactionId === providerTransactionId);
    if (!transfer) throw new Error(`unknown transfer ${providerTransactionId}`);
    return transfer;
  }

  /** Move funds. Returns a failure reason, or undefined on success. */
  private debitCredit(transfer: StoredTransfer): string | undefined {
    const from = this.balances.get(transfer.fromAccountId) ?? 0;
    if (from < transfer.amountCents) return 'insufficient funds';
    this.balances.set(transfer.fromAccountId, from - transfer.amountCents);
    this.balances.set(transfer.toAccountId, (this.balances.get(transfer.toAccountId) ?? 0) + transfer.amountCents);
    return undefined;
  }

  private toResult(transfer: StoredTransfer): BankTransferResult {
    return {
      status: transfer.status,
      providerTransactionId: transfer.providerTransactionId,
      amountCents: transfer.amountCents,
      fromAccountId: transfer.fromAccountId,
      toAccountId: transfer.toAccountId,
      ...(transfer.reason ? { reason: transfer.reason } : {}),
    };
  }
}
