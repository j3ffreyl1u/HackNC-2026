import { readFile } from 'node:fs/promises';
import type { TripState } from '../contracts/index.js';
import { createNessieReader } from './nessie-reader.js';
import { depositTag } from '../planning/funding.js';
import { createFundService, type FundService } from './service.js';

/** A fund that can also take a simulated deposit. Only the sandbox and the offline mock implement it; the app never moves real money. */
export type PayableFundService = FundService & { deposit?(memberId: string, dollars: number, revision: number): Promise<void> };

export interface BoundFundOptions {
  /** JSON written by `npm run fund:sim -- provision`: { accountId, revision }. Read on every call, so setting up an account needs no restart. */
  bindingPath: string;
  /** JSON object of merchant id -> category, written by the same tool as purchases are added. Optional. */
  merchantsPath: string;
  baseUrl: string;
  apiKey: string;
  /** How long a ledger read is reused. Short on purpose so a payment shows up within a few seconds. */
  cacheMs?: number;
  fetcher?: typeof fetch;
}

/**
 * A fund service for the Nessie sandbox that looks up which account belongs to the approved plan each time, instead of
 * being told once at startup. Until an account has been set up for the plan it says so plainly and reads nothing.
 */
export function createBoundFundService(options: BoundFundOptions): PayableFundService {
  let current: { key: string; service: FundService } | undefined;
  const readJson = async (path: string): Promise<unknown | undefined> => {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; }
  };
  const bound = async (): Promise<FundService | undefined> => {
    const binding = await readJson(options.bindingPath) as { accountId?: unknown; revision?: unknown } | undefined;
    if (!binding || typeof binding.accountId !== 'string' || !binding.accountId || !Number.isSafeInteger(binding.revision)) return undefined;
    const merchants = (await readJson(options.merchantsPath)) ?? {};
    const key = `${binding.accountId}:${binding.revision}:${JSON.stringify(merchants)}`;
    if (current?.key !== key) {
      const categories = Object.fromEntries(Object.entries(merchants as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
      const reader = createNessieReader({ baseUrl: options.baseUrl, apiKey: options.apiKey, accountId: binding.accountId, merchantCategories: categories }, options.fetcher);
      current = { key, service: createFundService(reader, 'nessie', binding.revision as number, { cacheMs: options.cacheMs ?? 3000 }) };
    }
    return current.service;
  };
  const notReady = (state: TripState) => ({ status: 'not_ready' as const, reason: 'The sandbox fund account is not set up for this approved plan yet.', mode: 'nessie' as const, revision: state.revision });
  const deposit = async (memberId: string, dollars: number, revision: number) => {
    const binding = await readJson(options.bindingPath) as { accountId?: unknown; revision?: unknown } | undefined;
    if (!binding || typeof binding.accountId !== 'string' || binding.revision !== revision) throw new Error('The sandbox fund account is not set up for this plan.');
    if (!Number.isSafeInteger(dollars) || dollars <= 0 || dollars > 100_000) throw new Error('Deposits are whole dollars.');
    const base = new URL(options.baseUrl);
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/accounts/${encodeURIComponent(binding.accountId)}/deposits`, base.origin);
    url.searchParams.set('key', options.apiKey);
    const response = await (options.fetcher ?? fetch)(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ medium: 'balance', status: 'completed', transaction_date: new Date().toISOString().slice(0, 10), amount: dollars, description: depositTag(memberId, revision) }) });
    if (!response.ok) throw new Error(`The sandbox refused the deposit (HTTP ${response.status}).`);
    current = undefined;   // read the ledger fresh next time, so the new deposit shows straight away
  };
  return {
    deposit,
    async inspect(state: TripState) { const service = await bound(); return service ? service.inspect(state) : notReady(state); },
    async publicView(state: TripState) { const service = await bound(); return service ? service.publicView(state) : notReady(state); },
  } as unknown as PayableFundService;
}
