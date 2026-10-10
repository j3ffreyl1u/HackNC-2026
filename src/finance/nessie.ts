import type { BankSeeder, BankTransferResult, BankingAdapter, SubmitTransferInput } from './bank.js';
import { FinanceConfigError } from './runtime.js';

/**
 * Nessie (Capital One sandbox) adapter.
 *
 * VERIFICATION STATUS (see docs/finance.md): endpoint paths follow the classic Nessie REST layout that the
 * official nessieisreal SDK documents (create a transfer *from* an account, get a transfer by ID, list an
 * account's transfers as payer/payee, update/delete only before execution). The current prod docs site could
 * not be read programmatically and no API key was available, so NOTHING here has run against the live
 * service. Third-party 2026 reports say the sandbox may ignore balance changes, omit the payee, truncate
 * cents and offer no client reference, so the adapter treats every answer as untrusted:
 *
 *  - it reports what the bank says (including a missing payee) and leaves the match against the requested
 *    source, destination and amount to the caller (`transferMatches`); a missing field is never "close enough";
 *  - a definite 4xx rejection is `failed`; a timeout, network error or 5xx on a send THROWS, which the
 *    processor records as `unknown` and reconciles, never retries;
 *  - lookup by our operation ID works only through a tag we put in `description`, and "not found" is not
 *    treated as proof of absence unless explicitly configured, because list completeness is unverified.
 */

export interface NessieOptions {
  apiKey: string;
  /** Base URL of the Nessie API. Verify against current official docs; there is no built-in default. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Date for `transaction_date` (YYYY-MM-DD). Defaults to today (UTC). */
  today?: () => string;
  /** Status requested when creating a transfer. */
  requestStatus?: 'pending' | 'completed';
  /** Sandbox amounts are reported to truncate cents. Fractional-dollar transfers are refused unless allowed. */
  allowFractionalDollars?: boolean;
  /** Treat "no tagged transfer in the account's list" as proof it was never created. Unverified, so off. */
  absenceIsAuthoritative?: boolean;
  timeoutMs?: number;
}

/** A network failure, timeout or 5xx. The outcome of a send that fails this way is unknown. */
export class NessieUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NessieUnavailableError';
  }
}

interface NessieResponse {
  status: number;
  body: unknown;
}

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null);
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

/** The tag that links a Nessie transfer back to our durable operation. */
export function operationTag(operationId: string): string {
  return `[op:${operationId}]`;
}

export class NessieBank implements BankingAdapter, BankSeeder {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly http: typeof fetch;
  private readonly today: () => string;
  private readonly requestStatus: 'pending' | 'completed';
  private readonly allowFractional: boolean;
  private readonly absenceIsAuthoritative: boolean;
  private readonly timeoutMs: number;

  constructor(options: NessieOptions) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new FinanceConfigError('NESSIE_API_KEY is required when BANK_MODE=nessie');
    }
    if (!options.baseUrl || options.baseUrl.trim() === '') {
      throw new FinanceConfigError('NESSIE_BASE_URL is required when BANK_MODE=nessie (verify it against the current Nessie docs)');
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.http = options.fetch ?? fetch;
    this.today = options.today ?? (() => new Date().toISOString().slice(0, 10));
    this.requestStatus = options.requestStatus ?? 'completed';
    this.allowFractional = options.allowFractionalDollars ?? false;
    this.absenceIsAuthoritative = options.absenceIsAuthoritative ?? false;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  // ---- BankingAdapter ----------------------------------------------------------

  async getBalance(accountId: string): Promise<number> {
    const response = await this.request('GET', `/accounts/${encodeURIComponent(accountId)}`);
    const record = asRecord(response.body);
    if (response.status !== 200 || !record || typeof record.balance !== 'number') {
      throw new NessieUnavailableError(`could not read the balance of ${accountId} (HTTP ${response.status})`);
    }
    return dollarsToCents(record.balance);
  }

  async submitTransfer(input: SubmitTransferInput): Promise<BankTransferResult> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      return { status: 'failed', reason: 'invalid amount' };
    }
    if (!this.allowFractional && input.amountCents % 100 !== 0) {
      return { status: 'failed', reason: 'the Nessie sandbox is only trusted with whole-dollar amounts (cents may be truncated)' };
    }

    // From here on a failure to hear back leaves the outcome unknown, so it must throw, not return `failed`.
    const created = await this.request('POST', `/accounts/${encodeURIComponent(input.fromAccountId)}/transfers`, {
      medium: 'balance',
      payee_id: input.toAccountId,
      transaction_date: this.today(),
      status: this.requestStatus,
      amount: centsToDollars(input.amountCents),
      description: `${operationTag(input.operationId)} ${input.description}`,
    });

    if (created.status >= 500) throw new NessieUnavailableError(`Nessie answered HTTP ${created.status} to a transfer`);
    if (created.status >= 400) {
      return { status: 'failed', reason: this.describeRejection(created) };
    }

    const providerId = this.createdId(created.body);
    if (!providerId) {
      return { status: 'unknown', reason: 'Nessie accepted the transfer but returned no transfer ID' };
    }
    try {
      return await this.getTransfer(providerId);
    } catch {
      return { status: 'unknown', providerTransactionId: providerId, reason: 'the transfer was created but could not be read back' };
    }
  }

  async getTransfer(providerTransactionId: string): Promise<BankTransferResult> {
    const response = await this.request('GET', `/transfers/${encodeURIComponent(providerTransactionId)}`);
    if (response.status >= 500) throw new NessieUnavailableError(`Nessie answered HTTP ${response.status}`);
    if (response.status === 404) return { status: 'unknown', providerTransactionId, reason: 'Nessie has no transfer with that ID' };
    const record = asRecord(response.body);
    if (response.status !== 200 || !record) {
      return { status: 'unknown', providerTransactionId, reason: `unexpected answer from Nessie (HTTP ${response.status})` };
    }
    return this.interpret(record, providerTransactionId);
  }

  async findTransfer(operationId: string, fromAccountId: string): Promise<BankTransferResult | null> {
    const response = await this.request('GET', `/accounts/${encodeURIComponent(fromAccountId)}/transfers`, undefined, { type: 'payer' });
    if (response.status >= 500) throw new NessieUnavailableError(`Nessie answered HTTP ${response.status}`);
    if (response.status !== 200 || !Array.isArray(response.body)) {
      return { status: 'unknown', reason: `could not list transfers for ${fromAccountId} (HTTP ${response.status})` };
    }
    const tag = operationTag(operationId);
    const matches = response.body
      .map(asRecord)
      .filter((record): record is Json => record !== null && typeof record.description === 'string' && record.description.includes(tag));

    if (matches.length === 0) {
      return this.absenceIsAuthoritative ? null : { status: 'unknown', reason: 'no tagged transfer was listed, which does not prove it was never created' };
    }
    if (matches.length > 1) {
      return { status: 'unknown', reason: `${matches.length} Nessie transfers carry the same operation tag; needs a human look` };
    }
    return this.interpret(matches[0], asString(matches[0]._id) ?? asString(matches[0].id));
  }

  // ---- BankSeeder: adopt-only --------------------------------------------------

  /**
   * Nessie accounts are created by the operator (customer, then account) and their IDs placed in the
   * household config. This verifies that the account exists and returns its ID; it never creates one.
   */
  async provisionAccount(input: {
    label: string;
    initialBalanceCents: number;
    existingAccountId?: string;
    configuredAccountId?: string;
  }): Promise<string> {
    const accountId = input.existingAccountId ?? input.configuredAccountId;
    if (!accountId) {
      throw new FinanceConfigError(
        `no Nessie account ID for "${input.label}". Create the account in Nessie and put its ID in the household config.`,
      );
    }
    const response = await this.request('GET', `/accounts/${encodeURIComponent(accountId)}`);
    if (response.status >= 500) throw new NessieUnavailableError(`Nessie answered HTTP ${response.status}`);
    if (response.status !== 200 || asRecord(response.body) === null) {
      throw new FinanceConfigError(`Nessie account ${accountId} for "${input.label}" was not found (HTTP ${response.status})`);
    }
    return accountId;
  }

  // ---- internals ----------------------------------------------------------------

  private interpret(record: Json, fallbackId?: string): BankTransferResult {
    const rawStatus = typeof record.status === 'string' ? record.status.toLowerCase() : '';
    const status: BankTransferResult['status'] =
      rawStatus === 'completed' || rawStatus === 'executed'
        ? 'confirmed'
        : rawStatus === 'pending'
          ? 'pending'
          : rawStatus === 'cancelled' || rawStatus === 'canceled'
            ? 'failed'
            : 'unknown';
    const providerTransactionId = asString(record._id) ?? asString(record.id) ?? fallbackId;
    return {
      status,
      ...(providerTransactionId ? { providerTransactionId } : {}),
      ...(typeof record.amount === 'number' ? { amountCents: dollarsToCents(record.amount) } : {}),
      ...(asString(record.payer_id) ? { fromAccountId: asString(record.payer_id) } : {}),
      ...(asString(record.payee_id) ? { toAccountId: asString(record.payee_id) } : {}),
      ...(status === 'unknown' ? { reason: `unrecognized Nessie status "${rawStatus}"` } : {}),
    };
  }

  /** The create response reports the ID as `_id` in some places and `id` in others. */
  private createdId(body: unknown): string | undefined {
    const record = asRecord(body);
    if (!record) return undefined;
    const created = asRecord(record.objectCreated);
    return asString(created?._id) ?? asString(created?.id) ?? asString(record._id) ?? asString(record.id);
  }

  private describeRejection(response: NessieResponse): string {
    const record = asRecord(response.body);
    const message = asString(record?.message) ?? `HTTP ${response.status}`;
    return `rejected by Nessie: ${this.redact(message)}`.slice(0, 160);
  }

  private redact(text: string): string {
    return text.split(this.apiKey).join('[redacted]');
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<NessieResponse> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set('key', this.apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.http(url.toString(), {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      // The URL carries the key; never let it reach logs or messages.
      const reason = error instanceof Error && error.name === 'AbortError' ? 'timed out' : this.redact(error instanceof Error ? error.message : String(error));
      throw new NessieUnavailableError(`Nessie request failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
