import type { Deposit, Purchase } from '../planning/funding.js';

export interface FundLedger { deposits: Deposit[]; purchases: Purchase[] }
export interface FundReader { read(): Promise<FundLedger> }
export interface NessieConfig { baseUrl: string; apiKey: string; accountId: string; merchantCategories?: Record<string, string> }

/** No mutation methods: every request made by this adapter is GET. */
export function createNessieReader(config: NessieConfig, fetcher: typeof fetch = fetch): FundReader {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Nessie requires a clean HTTPS base URL.');
  if (!config.apiKey.trim() || !config.accountId.trim()) throw new Error('Nessie key and dedicated account are required.');
  const get = async (path: string): Promise<unknown> => {
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/${path}`, base.origin);
    url.searchParams.set('key', config.apiKey);
    try {
      const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch { throw new Error('Nessie read unavailable; no fixture data was substituted.'); }
  };
  return { async read() {
    const id = encodeURIComponent(config.accountId);
    const [rawDeposits, rawPurchases] = await Promise.all([get(`accounts/${id}/deposits`), get(`accounts/${id}/purchases`)]);
    if (!Array.isArray(rawDeposits) || !Array.isArray(rawPurchases)) throw new Error('Nessie returned an invalid transaction list.');
    const deposits = rawDeposits.map(raw => {
      const row = transaction(raw);
      return { id: row._id, amountDollars: row.amount, description: typeof row.description === 'string' ? row.description : '', status: row.status };
    });
    const purchases: Purchase[] = [];
    for (const raw of rawPurchases) {
      const row = transaction(raw);
      if (typeof row.merchant_id !== 'string' || !row.merchant_id) throw new Error('A Nessie purchase has no merchant ID.');
      // Mapping records the merchant category used by the simulator; unknown merchants stay unclassified.
      purchases.push({ id: row._id, amountDollars: row.amount, status: row.status, category: config.merchantCategories?.[row.merchant_id] });
    }
    return { deposits, purchases };
  } };
}

function transaction(raw: unknown): { _id: string; amount: number; status: string; description?: unknown; merchant_id?: unknown } {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid Nessie transaction.');
  const row = raw as Record<string, unknown>;
  if (typeof row._id !== 'string' || !row._id || typeof row.amount !== 'number' || !Number.isSafeInteger(row.amount) || row.amount < 0 || typeof row.status !== 'string') throw new Error('Invalid Nessie transaction.');
  return row as ReturnType<typeof transaction>;
}
