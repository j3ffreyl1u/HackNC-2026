import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Sets up the demo's money in the Nessie SANDBOX: one fake account per friend, and purchases on each friend's own account
 * ("Mason paid $110 for the cabin"). The bot only ever reads these; this script is the only thing that writes.
 */
interface Simulation {
  /** Trip member IDs, one fake account each. Defaults to everyone named in `purchases`. */
  members?: string[];
  purchases: Array<{ memberId: string; merchantId?: string; category?: string; dollars: number; note?: string }>;
}

/**
 * The body for creating a simulated merchant. `category` is a plain string: the live sandbox answers a list with
 * 400 "str type expected" (checked 2026-10-11), so it must not be wrapped in an array.
 */
export function merchantBody(category: string, address: Record<string, string>) {
  return { name: `SIMULATED ${category}`, category, address, geocode: { lat: 35.9132, lng: -79.0558 } };
}

const PLACEHOLDER_MERCHANT = 'SIMULATED_MERCHANT_CREATED_ON_EXECUTE';
const MEMBER_ID = /^[a-zA-Z0-9_-]+$/;

export function membersOf(input: Simulation): string[] {
  const named = input.members ?? [...new Set(input.purchases.map((p) => p.memberId))];
  if (named.length === 0 || named.length > 12 || named.some((m) => typeof m !== 'string' || !MEMBER_ID.test(m))) throw new Error('Name between 1 and 12 trip members, using letters, numbers, - or _.');
  return [...new Set(named)];
}

export function simulationPayloads(raw: unknown, date: string) {
  const input = raw as Simulation;
  if (!input || !Array.isArray(input.purchases)) throw new Error('Invalid simulated fund manifest.');
  const members = new Set(membersOf(input));
  const amount = (value: number) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Simulated amounts must be positive whole dollars.');
    return value;
  };
  return input.purchases.map((p) => {
    if (typeof p.memberId !== 'string' || !members.has(p.memberId)) throw new Error('Every purchase needs the ID of a trip member who has an account.');
    if ((!p.merchantId || typeof p.merchantId !== 'string') && (!p.category || typeof p.category !== 'string')) throw new Error('Supply a sandbox merchant ID or a plain category for provisioning.');
    return {
      memberId: p.memberId,
      endpoint: 'purchases' as const,
      body: { merchant_id: p.merchantId ?? PLACEHOLDER_MERCHANT, medium: 'balance', status: 'completed', purchase_date: date, amount: amount(p.dollars), description: `SIMULATED trip purchase: ${p.note ?? p.category ?? 'purchase'}` },
    };
  });
}

async function run() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file || args.some(a => a.startsWith('--') && !['--execute', '--provision'].includes(a))) throw new Error('Usage: npm run simulate:fund -- manifest.json [--provision] [--execute]');
  const input = JSON.parse(await readFile(file, 'utf8')) as Simulation;
  const members = membersOf(input);
  const payloads = simulationPayloads(input, new Date().toISOString().slice(0, 10));
  console.log('SIMULATED NESSIE SANDBOX TRANSACTIONS. No real money.');
  const provision = args.includes('--provision');
  if (!provision && input.purchases.some(p => !p.merchantId)) throw new Error('Each purchase needs an existing merchant ID or --provision.');
  if (provision && input.purchases.some(p => !p.category || typeof p.category !== 'string')) throw new Error('Provisioning requires a plain merchant category on every purchase.');
  const address = { street_number: '1', street_name: 'Simulation Way', city: 'Chapel Hill', state: 'NC', zip: '27514' };
  const categories = [...new Set(input.purchases.map(p => p.category).filter((c): c is string => typeof c === 'string'))];
  if (!args.includes('--execute')) {
    console.log(JSON.stringify({
      ...(provision ? { customersAndAccounts: members.map(m => ({ customer: { first_name: 'SIMULATED', last_name: m, address }, account: { type: 'Checking', nickname: `SIMULATED ${m}`, rewards: 0, balance: 0 } })), merchants: categories.map(c => merchantBody(c, address)) } : {}),
      transactions: payloads,
    }, null, 2));
    console.log(`Preview only. --execute posts once${provision ? ` (${members.length} customers, ${members.length} accounts, ${categories.length} merchants, ${payloads.length} purchases)` : ''}; rerunning creates duplicates.`); return;
  }
  const env = process.env;
  if (!env.NESSIE_API_KEY || !env.NESSIE_BASE_URL || (!provision && !env.NESSIE_ACCOUNTS_PATH)) throw new Error('Configure the Nessie sandbox key and HTTPS base URL, plus NESSIE_ACCOUNTS_PATH or --provision.');
  const base = new URL(env.NESSIE_BASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Use a clean HTTPS Nessie sandbox URL.');
  const post = async (path: string, body: unknown) => {
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/${path}`, base.origin);
    url.searchParams.set('key', env.NESSIE_API_KEY!);
    try {
      const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      return await response.json() as { _id?: string; objectCreated?: { _id?: string } };
    } catch { throw new Error('Simulation stopped. Earlier objects or transactions may exist; reconcile before rerunning. No automatic retry.'); }
  };
  const createdId = (result: { _id?: string; objectCreated?: { _id?: string } }) => {
    const id = result.objectCreated?._id ?? result._id;
    if (!id) throw new Error('Simulation created an object but no ID was returned; inspect the sandbox before rerunning.');
    return id;
  };
  let accounts: Record<string, string> = {};
  const merchantIds = new Map<string, string>();
  const merchantCategories: Record<string, string> = {};
  if (provision) {
    for (const member of members) {
      const customerId = createdId(await post('customers', { first_name: 'SIMULATED', last_name: member, address }));
      accounts[member] = createdId(await post(`customers/${encodeURIComponent(customerId)}/accounts`, { type: 'Checking', nickname: `SIMULATED ${member}`, rewards: 0, balance: 0 }));
    }
    for (const category of categories) {
      const id = createdId(await post('merchants', merchantBody(category, address)));
      merchantIds.set(category, id);
      merchantCategories[id] = category;
    }
    await mkdir('data', { recursive: true });
    await writeFile('data/simulated-accounts.json', JSON.stringify(accounts, null, 2));
    await writeFile('data/simulated-merchant-categories.json', JSON.stringify(merchantCategories, null, 2));
    console.log('SIMULATED accounts saved to data/simulated-accounts.json and merchants to data/simulated-merchant-categories.json. Point NESSIE_ACCOUNTS_PATH and NESSIE_MERCHANTS_PATH at them.');
  } else {
    accounts = JSON.parse(await readFile(env.NESSIE_ACCOUNTS_PATH!, 'utf8')) as Record<string, string>;
  }
  for (const [index, payload] of payloads.entries()) {
    const source = input.purchases[index]!;
    const body = { ...payload.body, merchant_id: source.merchantId ?? merchantIds.get(source.category!) ?? payload.body.merchant_id };
    if (body.merchant_id === PLACEHOLDER_MERCHANT) throw new Error('Purchase needs --provision or an existing sandbox merchant ID.');
    const account = accounts[payload.memberId];
    if (!account) throw new Error(`No account for ${payload.memberId}; provision or add it to NESSIE_ACCOUNTS_PATH.`);
    await post(`accounts/${encodeURIComponent(account)}/${payload.endpoint}`, body);
    console.log(`SIMULATED ${payload.memberId} purchase ${index + 1}/${payloads.length} posted. Read back completed status before counting it.`);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void run().catch(error => { console.error(error instanceof Error ? error.message : 'Simulation failed.'); process.exitCode = 1; });
