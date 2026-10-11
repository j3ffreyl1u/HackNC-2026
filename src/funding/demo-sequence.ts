import type { FundReader } from './nessie-reader.js';

/**
 * The demo's "bank statement" walk-through. After a plan is approved the agent lists each friend's Nessie sandbox account
 * (empty), then purchases are posted to those accounts one at a time and the accounts are read back and sent after each,
 * ending with who owes whom. Everything here is the Nessie SANDBOX: fake customers, fake accounts, fake money.
 * The agent itself never pays; only this scripted demo writes to the sandbox, and the messages come from reading it back.
 */

export interface DemoStep {
  memberId: string;
  /** A plain merchant category the ledger understands: hotel, gas, restaurant, parks. */
  category: string;
  dollars: number;
  /** How the purchase reads in a message: "the hotel". */
  what: string;
  /** Wait this long before posting it. */
  delayMs: number;
}

export interface NessieWriter {
  createAccount(label: string): Promise<string>;
  createMerchant(category: string): Promise<string>;
  postPurchase(accountId: string, merchantId: string, dollars: number, description: string, date: string): Promise<void>;
}

const ADDRESS = { street_number: '1', street_name: 'Simulation Way', city: 'Chapel Hill', state: 'NC', zip: '27514' };

/** Writes only to the sandbox, and only what the demo scripts (customers, accounts, merchants, purchases). */
export function createNessieWriter(config: { baseUrl: string; apiKey: string }, fetcher: typeof fetch = fetch): NessieWriter {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Nessie requires a clean HTTPS base URL.');
  const post = async (path: string, body: unknown): Promise<string> => {
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/${path}`, base.origin);
    url.searchParams.set('key', config.apiKey);
    let json: { _id?: string; objectCreated?: { _id?: string } };
    try {
      const response = await fetcher(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      json = await response.json() as typeof json;
    } catch { throw new Error('The Nessie sandbox did not accept the demo request.'); }
    const id = json.objectCreated?._id ?? json._id;
    if (!id) throw new Error('The Nessie sandbox returned no ID.');
    return id;
  };
  return {
    async createAccount(label) {
      const customer = await post('customers', { first_name: 'SIMULATED', last_name: label, address: ADDRESS });
      return post(`customers/${encodeURIComponent(customer)}/accounts`, { type: 'Checking', nickname: `SIMULATED ${label}`, rewards: 0, balance: 0 });
    },
    createMerchant: (category) => post('merchants', { name: `SIMULATED ${category}`, category, address: ADDRESS, geocode: { lat: 35.9132, lng: -79.0558 } }),
    async postPurchase(accountId, merchantId, dollars, description, date) {
      await post(`accounts/${encodeURIComponent(accountId)}/purchases`, { merchant_id: merchantId, medium: 'balance', status: 'completed', purchase_date: date, amount: dollars, description });
    },
  };
}

/** Mason pays the hotel, Jeffrey pays gas, then dinner (food stays personal) and one more shared bill. Falls back to the people on the trip. */
export const DEFAULT_STEPS = (members: string[]): DemoStep[] => {
  const pick = (id: string, index: number) => members.find((m) => m.toLowerCase() === id) ?? members[index] ?? members[0] ?? id;
  const mason = pick('mason', 1);
  const jeffrey = pick('jeffrey', 0);
  return [
    { memberId: mason, category: 'hotel', dollars: 110, what: 'the hotel', delayMs: 3000 },
    { memberId: jeffrey, category: 'gas', dollars: 60, what: 'gas', delayMs: 1000 },
    { memberId: jeffrey, category: 'restaurant', dollars: 48, what: 'dinner', delayMs: 2000 },
    { memberId: mason, category: 'parks', dollars: 40, what: 'park tickets', delayMs: 2000 },
  ];
};

const WORDS: Record<string, string> = { hotel: 'hotel', gas: 'gas', restaurant: 'food', parks: 'park tickets', food: 'food' };

export interface DemoDeps {
  writer: NessieWriter;
  reader: FundReader;
  /** The accounts the reader uses: trip member ID to Nessie account ID. Replaced with fresh accounts at the start. */
  accounts: Record<string, string>;
  /** Merchant ID to category, shared with the reader so it can tell what each purchase was. */
  merchantCategories: Record<string, string>;
}

export interface DemoRun {
  memberIds: string[];
  nameOf(memberId: string): string;
  /** Sends one message to everyone on the trip. */
  send(text: string): Promise<void>;
  /** The settle-up text (who owes whom), computed by the ledger from the accounts. */
  settleUp(): Promise<string>;
  steps?: DemoStep[];
  sleep?: (ms: number) => Promise<void>;
  today?: () => string;
}

async function listing(deps: DemoDeps, run: DemoRun): Promise<string[]> {
  const { purchases } = await deps.reader.read();
  return run.memberIds.map((id) => {
    const mine = purchases.filter((p) => p.memberId === id && p.status === 'completed');
    return `${run.nameOf(id)}: ${mine.length === 0 ? 'no transactions yet' : mine.map((p) => `$${p.amountDollars} ${WORDS[(p.category ?? '').toLowerCase()] ?? p.category ?? 'purchase'}`).join(', ')}`;
  });
}

/** The whole walk-through. Safe to call once per approved plan; it starts from fresh, empty sandbox accounts so every run begins at zero. */
export async function runDemoSequence(deps: DemoDeps, run: DemoRun): Promise<void> {
  const sleep = run.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const date = (run.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const steps = run.steps ?? DEFAULT_STEPS(run.memberIds);
  for (const id of run.memberIds) deps.accounts[id] = await deps.writer.createAccount(run.nameOf(id));
  const merchants = new Map<string, string>();
  await run.send(['Trip bank accounts (Nessie sandbox, simulated money):', ...await listing(deps, run)].join('\n'));
  for (const step of steps) {
    await sleep(step.delayMs);
    let merchant = merchants.get(step.category);
    if (!merchant) {
      merchant = await deps.writer.createMerchant(step.category);
      merchants.set(step.category, merchant);
      deps.merchantCategories[merchant] = step.category;
    }
    await deps.writer.postPurchase(deps.accounts[step.memberId]!, merchant, step.dollars, `SIMULATED trip purchase: ${step.what}`, date);
    await run.send([`New transaction: ${run.nameOf(step.memberId)} paid $${step.dollars} for ${step.what}.`, ...await listing(deps, run)].join('\n'));
  }
  await sleep(2000);
  await run.send(['Final transactions:', ...await listing(deps, run), 'Food stays personal, so it is not split. Everything else is split evenly.'].join('\n'));
  await sleep(1500);
  await run.send(await run.settleUp());
}
