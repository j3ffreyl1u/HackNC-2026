// App-level banking interface owned by B. These are our own abstractions,
// not claims about the Nessie SDK's methods (see nessie.ts for the mapping).

export type BankTransferStatus = 'confirmed' | 'pending' | 'failed' | 'unknown';

export interface BankTransferResult {
  status: BankTransferStatus;
  providerTransactionId?: string;
  amountCents?: number;
  fromAccountId?: string;
  toAccountId?: string;
  reason?: string;
}

export interface SubmitTransferInput {
  /** Our durable operation ID, persisted before this call is made. */
  operationId: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  description: string;
}

export interface BankingAdapter {
  /** Available sandbox balance in cents. */
  getBalance(accountId: string): Promise<number>;
  /**
   * May throw on network failure or timeout. A throw means the outcome is unknown:
   * the caller must reconcile before any retry.
   */
  submitTransfer(input: SubmitTransferInput): Promise<BankTransferResult>;
  getTransfer(providerTransactionId: string): Promise<BankTransferResult>;
  /**
   * Look up a transfer we may have submitted. `null` means the provider positively has
   * no such transfer. If the provider cannot look up by operation, return `unknown`;
   * never guess from a coincidentally equal amount.
   */
  findTransfer(operationId: string, fromAccountId: string): Promise<BankTransferResult | null>;
}

/** Confirm a provider result matches what we asked for before counting it as paid. */
export function transferMatches(
  result: BankTransferResult,
  expected: { fromAccountId: string; toAccountId: string; amountCents: number },
): boolean {
  return (
    result.amountCents === expected.amountCents &&
    result.fromAccountId === expected.fromAccountId &&
    result.toAccountId === expected.toAccountId
  );
}
