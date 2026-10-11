import type { Purchase } from '../planning/funding.js';

/** Everyone's purchases, each tagged with whose account it came from. Nobody pays into a shared account. */
export interface FundLedger { purchases: Purchase[] }
export interface FundReader { read(): Promise<FundLedger> }
export interface NessieConfig {
  baseUrl: string;
  apiKey: string;
  /** Each friend's own (sandbox) account: trip member ID to Nessie account ID. */
  accounts: Record<string, string>;
  merchantCategories?: Record<string, string>;
}

const MAX_ACCOUNTS = 12;

/** No mutation methods: every request made by this adapter is GET. */
export function createNessieReader(config: NessieConfig, fetcher: typeof fetch = fetch): FundReader {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Nessie requires a clean HTTPS base URL.');
  const members = Object.entries(config.accounts);
  if (!config.apiKey.trim() || members.length === 0 || members.length > MAX_ACCOUNTS || members.some(([member, account]) => !member.trim() || typeof account !== 'string' || !account.trim())) throw new Error('Nessie needs a key and one account for each friend on the trip.');
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
    // Read at call time: the demo swaps in fresh accounts, and the page must follow.
    const lists = await Promise.all(Object.entries(config.accounts).map(async ([memberId, accountId]) => ({ memberId, raw: await get(`accounts/${encodeURIComponent(accountId)}/purchases`) })));
    const purchases: Purchase[] = [];
    for (const { memberId, raw } of lists) {
      if (!Array.isArray(raw)) throw new Error('Nessie returned an invalid transaction list.');
      for (const entry of raw) {
        const row = transaction(entry);
        if (typeof row.merchant_id !== 'string' || !row.merchant_id) throw new Error('A Nessie purchase has no merchant ID.');
        // The mapping records the category of each merchant the simulator created; an unknown merchant stays unclassified.
        purchases.push({
          id: row._id,
          memberId,
          amountDollars: row.amount,
          status: row.status,
          category: config.merchantCategories?.[row.merchant_id],
          ...(typeof row.purchase_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.purchase_date) ? { date: row.purchase_date.slice(0, 10) } : {}),
        });
      }
    }
    return { purchases };
  } };
}

function transaction(raw: unknown): { _id: string; amount: number; status: string; purchase_date?: unknown; merchant_id?: unknown } {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid Nessie transaction.');
  const row = raw as Record<string, unknown>;
  if (typeof row._id !== 'string' || !row._id || typeof row.amount !== 'number' || !Number.isSafeInteger(row.amount) || row.amount < 0 || typeof row.status !== 'string') throw new Error('Invalid Nessie transaction.');
  return row as ReturnType<typeof transaction>;
}
