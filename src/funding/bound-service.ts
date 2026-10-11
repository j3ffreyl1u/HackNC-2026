import { readFile } from 'node:fs/promises';
import type { TripState } from '../contracts/index.js';
import { createNessieReader } from './nessie-reader.js';
import { createFundService, type FundService } from './service.js';

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
export function createBoundFundService(options: BoundFundOptions): FundService {
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
  return {
    async inspect(state: TripState) { const service = await bound(); return service ? service.inspect(state) : notReady(state); },
    async publicView(state: TripState) { const service = await bound(); return service ? service.publicView(state) : notReady(state); },
  } as unknown as FundService;
}
