import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { depositTag } from '../src/planning/funding.js';

interface Simulation { revision: number; deposits: Array<{ memberId: string; dollars: number }>; purchases: Array<{ merchantId?: string; category?: string; dollars: number }> }
export function simulationPayloads(raw: unknown, date: string) {
  const input = raw as Simulation;
  if (!input || !Number.isSafeInteger(input.revision) || input.revision < 0 || !Array.isArray(input.deposits) || !Array.isArray(input.purchases)) throw new Error('Invalid simulated fund manifest.');
  const amount = (value: number) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Simulated amounts must be positive whole dollars.');
    return value;
  };
  return [
    ...input.deposits.map(d => {
      if (typeof d.memberId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(d.memberId)) throw new Error('Invalid simulated member ID.');
      return { endpoint: 'deposits', body: { medium: 'balance', status: 'completed', transaction_date: date, amount: amount(d.dollars), description: depositTag(d.memberId, input.revision) } };
    }),
    ...input.purchases.map(p => {
      if ((!p.merchantId || typeof p.merchantId !== 'string') && (!p.category || typeof p.category !== 'string')) throw new Error('Supply a sandbox merchant ID or a plain category for provisioning.');
      return { endpoint: 'purchases', body: { merchant_id: p.merchantId ?? 'SIMULATED_MERCHANT_CREATED_ON_EXECUTE', medium: 'balance', status: 'completed', purchase_date: date, amount: amount(p.dollars), description: `SIMULATED trip purchase;rev=${input.revision}` } };
    }),
  ];
}

async function run() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file || args.some(a => a.startsWith('--') && !['--execute', '--provision'].includes(a))) throw new Error('Usage: npm run simulate:fund -- manifest.json [--provision] [--execute]');
  const input = JSON.parse(await readFile(file, 'utf8')) as Simulation;
  const payloads = simulationPayloads(input, new Date().toISOString().slice(0, 10));
  console.log('SIMULATED NESSIE SANDBOX TRANSACTIONS. No real money.');
  const provision = args.includes('--provision');
  if (!provision && input.purchases.some(p => !p.merchantId)) throw new Error('Each purchase needs an existing merchant ID or --provision.');
  if (provision && input.purchases.some(p => !p.category || typeof p.category !== 'string')) throw new Error('Provisioning requires a plain merchant category on every purchase.');
  const address = { street_number: '1', street_name: 'Simulation Way', city: 'Chapel Hill', state: 'NC', zip: '27514' };
  const customer = { first_name: 'SIMULATED', last_name: 'Trip Group', address };
  const account = { type: 'Checking', nickname: `SIMULATED trip revision ${input.revision}`, rewards: 0, balance: 0 };
  if (!args.includes('--execute')) {
    console.log(JSON.stringify({ ...(provision ? { customer, account, merchants: input.purchases.map(p => ({ name: `SIMULATED ${p.category}`, category: p.category, address, geocode: { lat: 35.9132, lng: -79.0558 } })) } : {}), transactions: payloads }, null, 2));
    console.log('Preview only. --execute posts once; rerunning creates duplicates.'); return;
  }
  const env = process.env;
  if (!env.NESSIE_API_KEY || !env.NESSIE_BASE_URL || (!provision && !env.NESSIE_ACCOUNT_ID)) throw new Error('Configure the Nessie sandbox key and HTTPS base URL, plus an existing account or --provision.');
  if (!provision && Number(env.NESSIE_PLAN_REVISION) !== input.revision) throw new Error('Manifest revision must match NESSIE_PLAN_REVISION.');
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
  let accountId = env.NESSIE_ACCOUNT_ID!;
  const merchantCategories: Record<string, string> = {};
  if (provision) {
    const customerId = createdId(await post('customers', customer));
    accountId = createdId(await post(`customers/${encodeURIComponent(customerId)}/accounts`, account));
    for (const p of input.purchases) {
      p.merchantId = createdId(await post('merchants', { name: `SIMULATED ${p.category}`, category: p.category, address, geocode: { lat: 35.9132, lng: -79.0558 } }));
      merchantCategories[p.merchantId] = p.category!;
    }
    await mkdir('data', { recursive: true });
    await writeFile('data/simulated-fund-binding.json', JSON.stringify({ simulated: true, accountId, revision: input.revision }, null, 2));
    await writeFile('data/simulated-merchant-categories.json', JSON.stringify(merchantCategories, null, 2));
    console.log('SIMULATED binding saved under data/. Configure account/revision and NESSIE_MERCHANTS_PATH from these files.');
  }
  const finalPayloads = simulationPayloads(input, new Date().toISOString().slice(0, 10));
  for (const [index, payload] of finalPayloads.entries()) {
    if ('merchant_id' in payload.body && payload.body.merchant_id === 'SIMULATED_MERCHANT_CREATED_ON_EXECUTE') throw new Error('Purchase needs --provision or an existing sandbox merchant ID.');
    await post(`accounts/${encodeURIComponent(accountId)}/${payload.endpoint}`, payload.body);
    console.log(`SIMULATED ${payload.endpoint} ${index + 1}/${finalPayloads.length} posted. Read back completed status before counting it.`);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void run().catch(error => { console.error(error instanceof Error ? error.message : 'Simulation failed.'); process.exitCode = 1; });
