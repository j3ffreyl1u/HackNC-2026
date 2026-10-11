/**
 * Sandbox money for the trip fund, one small step at a time. Everything it writes is labeled SIMULATED and goes to the Nessie
 * sandbox only; the app itself never writes. Run with: npm run fund:sim -- <command>
 *
 *   provision              create the sandbox account for the currently approved plan (once per approved revision)
 *   pay <person> <dollars> a deposit toward that person's share, tagged with their name and the plan revision
 *   spend <category> <dollars>   a purchase from the pot (hotel, gas, food, activities, fees, other)
 *   status                 what the sandbox account holds right now
 *
 * Needs NESSIE_API_KEY and NESSIE_BASE_URL (from .env) and DATABASE_PATH (the live trip database, read from a copy).
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toPlanningState } from '../src/app/planning-adapter.js';
import { createNessieReader } from '../src/funding/nessie-reader.js';
import { depositTag, planContributions } from '../src/planning/funding.js';
import { merchantBody } from './simulate-fund.js';

const BINDING = process.env.NESSIE_BINDING_PATH || 'data/simulated-fund-binding.json';
const MERCHANTS = process.env.NESSIE_MERCHANTS_PATH || 'data/simulated-merchant-categories.json';
const CATEGORY_WORDS: Record<string, string> = {
  hotel: 'accommodation', lodging: 'accommodation', accommodation: 'accommodation', cabin: 'accommodation',
  gas: 'fuel_parking_tolls', fuel: 'fuel_parking_tolls', parking: 'fuel_parking_tolls', tolls: 'fuel_parking_tolls', fuel_parking_tolls: 'fuel_parking_tolls',
  food: 'food', meals: 'food', dinner: 'food', activities: 'activities', tickets: 'activities', fees: 'taxes_fees', taxes: 'taxes_fees', taxes_fees: 'taxes_fees', other: 'other',
};
const address = { street_number: '1', street_name: 'Simulation Way', city: 'Chapel Hill', state: 'NC', zip: '27514' };

/** The approved plan from a COPY of the live database, so the running app is never touched. */
export function approvedPlan(databasePath: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fund-sim-'));
  try {
    copyFileSync(databasePath, join(dir, 'db.sqlite'));
    for (const ext of ['-wal', '-shm']) if (existsSync(databasePath + ext)) copyFileSync(databasePath + ext, join(dir, `db.sqlite${ext}`));
    const db = new Database(join(dir, 'db.sqlite'));
    const row = (db.prepare('select * from trips').all() as Array<{ state_json: string }>)[0];
    db.close();
    if (!row) throw new Error('No trip found in that database.');
    const state = JSON.parse(row.state_json);
    const plan = planContributions(toPlanningState(state));
    if (!plan.ok) throw new Error(`No approved plan yet: ${plan.reason}`);
    return { state, plan };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const config = () => {
  const apiKey = process.env.NESSIE_API_KEY, baseUrl = process.env.NESSIE_BASE_URL;
  if (!apiKey || !baseUrl) throw new Error('NESSIE_API_KEY and NESSIE_BASE_URL are needed (load .env).');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Use a clean HTTPS Nessie base URL.');
  return { apiKey, base };
};
async function post(path: string, body: unknown): Promise<string> {
  const { apiKey, base } = config();
  const url = new URL(`${base.pathname.replace(/\/$/, '')}/${path}`, base.origin);
  url.searchParams.set('key', apiKey);
  const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Nessie refused that (HTTP ${response.status}). Nothing was retried.`);
  const json = await response.json() as { _id?: string; objectCreated?: { _id?: string } };
  const id = json.objectCreated?._id ?? json._id;
  if (!id) throw new Error('Nessie did not return an id; check the sandbox before trying again.');
  return id;
}
const readJson = (path: string): any => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
const writeJson = (path: string, value: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2)); };
const today = () => new Date().toISOString().slice(0, 10);
const whole = (text: string | undefined) => { const n = Number(text); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Give a whole number of dollars, like 50.'); return n; };

export async function run(argv: string[], databasePath = process.env.DATABASE_PATH): Promise<string> {
  const [command, a, b] = argv;
  if (!databasePath && command !== 'status') throw new Error('DATABASE_PATH (the live trip database) is needed.');
  if (command === 'provision') {
    const { plan } = approvedPlan(databasePath!);
    const existing = readJson(BINDING);
    if (existing?.accountId && existing.revision === plan.revision) return `Already set up for revision ${plan.revision}. Nothing was created.`;
    const customer = await post('customers', { first_name: 'SIMULATED', last_name: 'Trip Group', address });
    const accountId = await post(`customers/${encodeURIComponent(customer)}/accounts`, { type: 'Checking', nickname: `SIMULATED trip revision ${plan.revision}`, rewards: 0, balance: 0 });
    writeJson(BINDING, { simulated: true, accountId, revision: plan.revision });
    writeJson(MERCHANTS, {});
    return `Created a SIMULATED sandbox account for the approved plan (revision ${plan.revision}, ${plan.neededDollars} dollars needed). The app picks it up on its own.`;
  }
  const binding = readJson(BINDING);
  if (command === 'status') {
    if (!binding?.accountId) return 'No sandbox account yet. Run provision after a plan is approved.';
    const { apiKey, base } = config();
    const ledger = await createNessieReader({ baseUrl: base.toString(), apiKey, accountId: binding.accountId, merchantCategories: readJson(MERCHANTS) ?? {} }).read();
    return `Revision ${binding.revision}. Deposits: ${ledger.deposits.map((d) => `${d.description.replace(/;rev=\d+/, '').replace('member=', '')} $${d.amountDollars}`).join(', ') || 'none'}. Purchases: ${ledger.purchases.map((p) => `${p.category ?? 'unclassified'} $${p.amountDollars}`).join(', ') || 'none'}.`;
  }
  if (!binding?.accountId) throw new Error('No sandbox account yet. Run provision after a plan is approved.');
  const { state, plan } = approvedPlan(databasePath!);
  if (binding.revision !== plan.revision) throw new Error(`The plan changed (account is for revision ${binding.revision}, the approved plan is ${plan.revision}). Delete ${BINDING} and run provision again.`);
  if (command === 'pay') {
    const name = (a ?? '').toLowerCase();
    const member = (state.roster ?? []).find((m: any) => m.memberId.toLowerCase() === name || m.displayName.toLowerCase() === name);
    if (!member) throw new Error(`Who is "${a}"? Use ${(state.roster ?? []).map((m: any) => m.displayName).join(' or ')}.`);
    const dollars = whole(b);
    await post(`accounts/${encodeURIComponent(binding.accountId)}/deposits`, { medium: 'balance', status: 'completed', transaction_date: today(), amount: dollars, description: depositTag(member.memberId, plan.revision) });
    return `SIMULATED deposit: ${member.displayName} paid $${dollars}.`;
  }
  if (command === 'spend') {
    const category = CATEGORY_WORDS[(a ?? '').toLowerCase()];
    if (!category) throw new Error(`Spend on what? Try hotel, gas, food, activities, fees or other.`);
    const dollars = whole(b);
    const merchants = readJson(MERCHANTS) ?? {};
    let merchantId = Object.entries(merchants).find(([, c]) => c === category)?.[0];
    if (!merchantId) { merchantId = await post('merchants', merchantBody(category, address)); writeJson(MERCHANTS, { ...merchants, [merchantId]: category }); }
    await post(`accounts/${encodeURIComponent(binding.accountId)}/purchases`, { merchant_id: merchantId, medium: 'balance', status: 'completed', purchase_date: today(), amount: dollars, description: `SIMULATED trip purchase;rev=${plan.revision}` });
    return `SIMULATED purchase: $${dollars} on ${category}.`;
  }
  throw new Error('Commands: provision | pay <person> <dollars> | spend <category> <dollars> | status');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run(process.argv.slice(2)).then((text) => console.log(text), (error) => { console.error(error instanceof Error ? error.message : 'Failed.'); process.exitCode = 1; });
}
