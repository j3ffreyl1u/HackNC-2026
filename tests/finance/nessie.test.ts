import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command, CommandPayload, ExecuteResult, HouseholdConfig } from '../../src/contracts/index.js';
import { transferMatches } from '../../src/finance/bank.js';
import { FinanceConfigError, createFinanceService, type FinanceService } from '../../src/finance/index.js';
import { Ledger } from '../../src/finance/ledger.js';
import { NessieBank, NessieUnavailableError, centsToDollars, dollarsToCents, operationTag } from '../../src/finance/nessie.js';
import { runNessieSmoke } from '../../src/finance/nessie-smoke.js';
import { LedgerStore } from '../../src/finance/store.js';

const KEY = 'test-secret-key-123';
const BASE = 'https://nessie.test/api';

interface StoredTransfer {
  _id: string;
  payer_id: string;
  payee_id?: string;
  amount: number;
  status: string;
  description: string;
  medium: string;
  transaction_date: string;
}

/** A stand-in Nessie that follows the documented shape and can be switched into the quirks third parties report. */
class FakeNessie {
  accounts = new Map<string, number>();
  transfers: StoredTransfer[] = [];
  calls: Array<{ method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null }> = [];
  // quirks and failure injection
  balancesMove = true;
  echoPayee = true;
  truncateToDollars = false;
  postRespondsWith: 'ok' | '400' | '500-after-create' | '500-before-create' | 'network-before' | 'network-after' | 'no-id' = 'ok';
  initialStatus = 'completed';
  hang = false;
  nextId = 1;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const path = url.pathname.replace(/^\/api/, '');
    this.calls.push({ method, path, query: url.searchParams, body });
    if (url.searchParams.get('key') !== KEY) return this.json(401, { message: 'invalid key' });
    if (this.hang) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }

    let match = path.match(/^\/accounts\/([^/]+)\/transfers$/);
    if (match && method === 'POST') return this.create(match[1], body!);
    if (match && method === 'GET') {
      const list = this.transfers.filter((t) => t.payer_id === match![1]);
      return this.json(200, list.map((t) => this.view(t)));
    }
    match = path.match(/^\/transfers\/([^/]+)$/);
    if (match && method === 'GET') {
      const found = this.transfers.find((t) => t._id === match![1]);
      return found ? this.json(200, this.view(found)) : this.json(404, { message: 'not found' });
    }
    match = path.match(/^\/accounts\/([^/]+)$/);
    if (match && method === 'GET') {
      return this.accounts.has(match[1]) ? this.json(200, { _id: match[1], balance: this.accounts.get(match[1]) }) : this.json(404, { message: 'no account' });
    }
    return this.json(404, { message: 'unknown route' });
  };

  private create(from: string, body: Record<string, unknown>): Response {
    switch (this.postRespondsWith) {
      case '400':
        return this.json(400, { message: `bad request for key ${KEY}` });
      case '500-before-create':
        return this.json(500, { message: 'boom' });
      case 'network-before':
        throw new TypeError(`fetch failed for https://nessie.test/api?key=${KEY}`);
      default:
        break;
    }
    const sent = body.amount as number;
    const stored: StoredTransfer = {
      _id: `nt-${this.nextId++}`,
      payer_id: from,
      ...(this.echoPayee ? { payee_id: body.payee_id as string } : {}),
      amount: this.truncateToDollars ? Math.floor(sent) : sent,
      status: this.initialStatus,
      description: String(body.description),
      medium: String(body.medium),
      transaction_date: String(body.transaction_date),
    };
    this.transfers.push(stored);
    if (this.balancesMove && stored.status === 'completed') this.move(from, body.payee_id as string, stored.amount);
    if (this.postRespondsWith === '500-after-create') return this.json(500, { message: 'gateway timeout' });
    if (this.postRespondsWith === 'network-after') throw new TypeError('socket hang up');
    if (this.postRespondsWith === 'no-id') return this.json(201, { message: 'Created', code: 201 });
    return this.json(201, { message: 'Created', code: 201, objectCreated: { _id: stored._id } });
  }

  settle(id: string, status: string) {
    const transfer = this.transfers.find((t) => t._id === id)!;
    transfer.status = status;
    if (status === 'completed' && this.balancesMove) this.move(transfer.payer_id, transfer.payee_id!, transfer.amount);
  }

  private move(from: string, to: string, dollars: number) {
    this.accounts.set(from, (this.accounts.get(from) ?? 0) - dollars);
    this.accounts.set(to, (this.accounts.get(to) ?? 0) + dollars);
  }

  private view(t: StoredTransfer) {
    const { _id, ...rest } = t;
    return { id: _id, ...rest }; // reads use `id`, creates use `_id`
  }

  private json(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }
}

let fake: FakeNessie;
const bankWith = (options: Partial<ConstructorParameters<typeof NessieBank>[0]> = {}) =>
  new NessieBank({ apiKey: KEY, baseUrl: BASE, fetch: fake.fetch, today: () => '2026-10-10', ...options });

const input = (overrides: Record<string, unknown> = {}) => ({
  operationId: 'op-7',
  fromAccountId: 'acct-mason',
  toAccountId: 'acct-house',
  amountCents: 4_800,
  description: 'October electricity share',
  ...overrides,
});

beforeEach(() => {
  fake = new FakeNessie();
  fake.accounts.set('acct-mason', 1_000);
  fake.accounts.set('acct-alex', 1_000);
  fake.accounts.set('acct-jordan', 1_000);
  fake.accounts.set('acct-house', 0);
  fake.accounts.set('acct-electric', 0);
});

describe('configuration and units', () => {
  it('refuses to start without a key or base URL, with readable errors', () => {
    expect(() => new NessieBank({ apiKey: '', baseUrl: BASE })).toThrow(FinanceConfigError);
    expect(() => new NessieBank({ apiKey: KEY, baseUrl: ' ' })).toThrow(/NESSIE_BASE_URL/);
    expect(() => new NessieBank({ apiKey: ' ', baseUrl: BASE })).toThrow(/NESSIE_API_KEY/);
  });

  it('converts between integer cents and dollars exactly', () => {
    expect([4_800, 14_400, 15_000, 9_800, 200, 115, 1].map(centsToDollars)).toEqual([48, 144, 150, 98, 2, 1.15, 0.01]);
    expect([48, 1.15, 0.01, 144.0].map(dollarsToCents)).toEqual([4_800, 115, 1, 14_400]);
  });
});

describe('submitTransfer', () => {
  it('creates the transfer from the payer with the documented fields, then reads it back', async () => {
    const result = await bankWith().submitTransfer(input());

    const post = fake.calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/accounts/acct-mason/transfers');
    expect(post.query.get('key')).toBe(KEY);
    expect(post.body).toEqual({
      medium: 'balance',
      payee_id: 'acct-house',
      transaction_date: '2026-10-10',
      status: 'completed',
      amount: 48,
      description: `${operationTag('op-7')} October electricity share`,
    });
    expect(fake.calls.some((c) => c.method === 'GET' && c.path === '/transfers/nt-1')).toBe(true);

    expect(result).toEqual({
      status: 'confirmed',
      providerTransactionId: 'nt-1',
      amountCents: 4_800,
      fromAccountId: 'acct-mason',
      toAccountId: 'acct-house',
    });
    expect(transferMatches(result, { fromAccountId: 'acct-mason', toAccountId: 'acct-house', amountCents: 4_800 })).toBe(true);
  });

  it('maps pending, cancelled and unrecognized statuses', async () => {
    fake.initialStatus = 'pending';
    expect((await bankWith().submitTransfer(input())).status).toBe('pending');
    fake.initialStatus = 'cancelled';
    expect((await bankWith().submitTransfer(input({ operationId: 'op-8' }))).status).toBe('failed');
    fake.initialStatus = 'executed';
    expect((await bankWith().submitTransfer(input({ operationId: 'op-9' }))).status).toBe('confirmed');
    fake.initialStatus = 'banana';
    const odd = await bankWith().submitTransfer(input({ operationId: 'op-10' }));
    expect(odd.status).toBe('unknown');
    expect(odd.reason).toContain('banana');
  });

  it('treats a definite 4xx as a failure and keeps the key out of the reason', async () => {
    fake.postRespondsWith = '400';
    const result = await bankWith().submitTransfer(input());
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('rejected by Nessie');
    expect(result.reason).not.toContain(KEY);
    expect(fake.calls.filter((c) => c.method === 'GET')).toHaveLength(0);
  });

  it.each(['500-before-create', 'network-before'] as const)('%s throws, so the outcome is treated as unknown', async (mode) => {
    fake.postRespondsWith = mode;
    const error = await bankWith().submitTransfer(input()).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(NessieUnavailableError);
    expect((error as Error).message).not.toContain(KEY);
  });

  it('a timeout throws and the request is aborted', async () => {
    fake.hang = true;
    await expect(bankWith({ timeoutMs: 20 }).submitTransfer(input())).rejects.toThrow(/timed out/);
  });

  it('refuses fractional dollars before sending anything, unless explicitly allowed', async () => {
    const refused = await bankWith().submitTransfer(input({ amountCents: 4_825 }));
    expect(refused.status).toBe('failed');
    expect(refused.reason).toContain('whole-dollar');
    expect(fake.calls).toHaveLength(0);

    const allowed = await bankWith({ allowFractionalDollars: true }).submitTransfer(input({ amountCents: 4_825 }));
    expect(allowed.amountCents).toBe(4_825);
  });

  it('rejects non-positive and non-integer amounts without a request', async () => {
    for (const amountCents of [0, -100, 100.5, Number.NaN]) {
      expect((await bankWith().submitTransfer(input({ amountCents }))).status).toBe('failed');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('a created transfer with no ID in the answer is unknown, not confirmed', async () => {
    fake.postRespondsWith = 'no-id';
    const result = await bankWith().submitTransfer(input());
    expect(result.status).toBe('unknown');
    expect(result.providerTransactionId).toBeUndefined();
  });

  it('keeps the provider ID when the read-back fails', async () => {
    const real = fake.fetch;
    let reads = 0;
    const bank = bankWith({
      fetch: async (url, init) => {
        if ((init?.method ?? 'GET') === 'GET' && String(url).includes('/transfers/')) {
          reads++;
          throw new TypeError('connection reset');
        }
        return real(url, init);
      },
    });
    const result = await bank.submitTransfer(input());
    expect(reads).toBe(1);
    expect(result).toMatchObject({ status: 'unknown', providerTransactionId: 'nt-1' });
  });
});

describe('what the bank leaves out is never filled in', () => {
  it('a sandbox that omits the payee yields a result that cannot match, so it is not paid', async () => {
    fake.echoPayee = false;
    const result = await bankWith().submitTransfer(input());
    expect(result.status).toBe('confirmed');
    expect(result.toAccountId).toBeUndefined();
    expect(transferMatches(result, { fromAccountId: 'acct-mason', toAccountId: 'acct-house', amountCents: 4_800 })).toBe(false);
  });

  it('a sandbox that truncates cents yields a mismatched amount', async () => {
    fake.truncateToDollars = true;
    const result = await bankWith({ allowFractionalDollars: true }).submitTransfer(input({ amountCents: 4_825 }));
    expect(result.amountCents).toBe(4_800);
    expect(transferMatches(result, { fromAccountId: 'acct-mason', toAccountId: 'acct-house', amountCents: 4_825 })).toBe(false);
  });
});

describe('findTransfer and getTransfer', () => {
  it('finds a transfer by the operation tag even when the create call reported a server error', async () => {
    fake.postRespondsWith = '500-after-create';
    await expect(bankWith().submitTransfer(input())).rejects.toBeInstanceOf(NessieUnavailableError);
    const found = await bankWith().findTransfer('op-7', 'acct-mason');
    expect(found).toMatchObject({ status: 'confirmed', providerTransactionId: 'nt-1', amountCents: 4_800 });
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(fake.calls.find((c) => c.path === '/accounts/acct-mason/transfers' && c.method === 'GET')!.query.get('type')).toBe('payer');
  });

  it('does not match a different operation whose ID merely starts the same', async () => {
    await bankWith().submitTransfer(input({ operationId: 'op-77' }));
    const found = await bankWith().findTransfer('op-7', 'acct-mason');
    expect(found?.status).toBe('unknown');
  });

  it('absence is unknown by default and null only when explicitly trusted', async () => {
    expect((await bankWith().findTransfer('never', 'acct-mason'))?.status).toBe('unknown');
    expect(await bankWith({ absenceIsAuthoritative: true }).findTransfer('never', 'acct-mason')).toBeNull();
  });

  it('flags several transfers with the same tag instead of picking one', async () => {
    const bank = bankWith();
    await bank.submitTransfer(input());
    await bank.submitTransfer(input());
    const found = await bank.findTransfer('op-7', 'acct-mason');
    expect(found?.status).toBe('unknown');
    expect(found?.reason).toContain('2 Nessie transfers');
  });

  it('only lists the source account\'s own transfers', async () => {
    await bankWith().submitTransfer(input({ fromAccountId: 'acct-alex' }));
    expect((await bankWith({ absenceIsAuthoritative: true }).findTransfer('op-7', 'acct-mason'))).toBeNull();
  });

  it('getTransfer reports a missing ID as unknown and a settled one as confirmed', async () => {
    fake.initialStatus = 'pending';
    const bank = bankWith();
    const pending = await bank.submitTransfer(input());
    expect(pending.status).toBe('pending');
    fake.settle(pending.providerTransactionId!, 'completed');
    expect((await bank.getTransfer(pending.providerTransactionId!)).status).toBe('confirmed');
    expect((await bank.getTransfer('nt-999')).status).toBe('unknown');
  });

  it('lookups throw on server errors so the caller keeps the operation unresolved', async () => {
    const bank = bankWith({ fetch: async () => new Response('{}', { status: 503 }) });
    await expect(bank.findTransfer('op-7', 'acct-mason')).rejects.toBeInstanceOf(NessieUnavailableError);
    await expect(bank.getTransfer('nt-1')).rejects.toBeInstanceOf(NessieUnavailableError);
  });
});

describe('balances and account adoption', () => {
  it('reads balances as integer cents', async () => {
    fake.accounts.set('acct-mason', 1_000.5);
    expect(await bankWith().getBalance('acct-mason')).toBe(100_050);
  });

  it('adopts the configured account after verifying it exists, and never creates one', async () => {
    const bank = bankWith();
    expect(await bank.provisionAccount({ label: 'm', initialBalanceCents: 0, configuredAccountId: 'acct-mason' })).toBe('acct-mason');
    expect(await bank.provisionAccount({ label: 'm', initialBalanceCents: 0, existingAccountId: 'acct-alex', configuredAccountId: 'ignored' })).toBe('acct-alex');
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('fails with an instruction when the account is missing or not configured', async () => {
    const bank = bankWith();
    await expect(bank.provisionAccount({ label: 'm', initialBalanceCents: 0, configuredAccountId: 'acct-nope' })).rejects.toThrow(/not found/);
    await expect(bank.provisionAccount({ label: 'm', initialBalanceCents: 0 })).rejects.toThrow(/Create the account in Nessie/);
  });
});

describe('with the finance service', () => {
  const config: HouseholdConfig = {
    householdId: 'demo-house',
    groupSpaceId: 'space-1',
    designatedPayerId: 'mason',
    householdAccountId: 'acct-house',
    members: [
      { userId: 'mason', displayName: 'Mason', providerUserId: 'p-mason', bankAccountId: 'acct-mason' },
      { userId: 'alex', displayName: 'Alex', providerUserId: 'p-alex', bankAccountId: 'acct-alex' },
      { userId: 'jordan', displayName: 'Jordan', providerUserId: 'p-jordan', bankAccountId: 'acct-jordan' },
    ],
    recipients: [{ recipientId: 'electric', displayName: 'Power Co', bankAccountId: 'acct-electric' }],
    demoCycles: [{ cycleId: '2026-10', bills: [] }],
  };

  let store: LedgerStore;
  let ledger: Ledger;
  let service: FinanceService;
  let counter = 0;
  let cmd = 0;

  beforeEach(async () => {
    counter = 0;
    cmd = 0;
    store = LedgerStore.open(':memory:');
    ledger = new Ledger(store);
    service = createFinanceService({
      store,
      bank: bankWith(),
      clock: { now: () => new Date('2026-10-10T12:00:00.000Z') },
      newId: (prefix) => `${prefix}-${++counter}`,
    });
    await service.bootstrapHousehold(config);
  });
  afterEach(() => store.close());

  function run(actorId: string, payload: CommandPayload): Promise<ExecuteResult> {
    const commandId = `cmd-${++cmd}`;
    const command: Command = { commandId, actorId, householdId: 'demo-house', sourceEventId: `evt-${commandId}`, payload };
    return service.execute(command);
  }

  async function mason() {
    await run('mason', { kind: 'add_bill', amountCents: 14_400, title: 'Electricity', dueDate: '2026-10-15', recipientId: 'electric', cycleId: '2026-10' });
    const bill = ledger.billsForCycle('demo-house', '2026-10')[0];
    const proposal = ledger.proposalsForBill(bill.billId).find((p) => p.requiredActorIds[0] === 'mason')!;
    return { bill, proposal };
  }

  it('a normal contribution is confirmed by the read-back and recorded', async () => {
    const { bill, proposal } = await mason();
    await run('mason', { kind: 'approve', proposalId: proposal.proposalId, proposalVersion: 1 });
    expect(ledger.confirmedByBeneficiary(bill.billId)).toEqual({ mason: 4_800 });
    expect(fake.transfers).toHaveLength(1);
  });

  it('a sandbox that omits the payee leaves the operation unknown and counts nothing as paid', async () => {
    fake.echoPayee = false;
    const { bill, proposal } = await mason();
    await run('mason', { kind: 'approve', proposalId: proposal.proposalId, proposalVersion: 1 });
    expect(ledger.confirmedTotal(bill.billId)).toBe(0);
    expect(store.unresolvedBankOperations().map((o) => o.status)).toEqual(['unknown']);
    expect(fake.transfers).toHaveLength(1);
    await service.reconcile('demo-house');
    expect(fake.transfers).toHaveLength(1); // never resubmitted
    expect(ledger.confirmedTotal(bill.billId)).toBe(0);
  });

  it('a lost answer after the bank accepted is resolved by the operation tag, with one transfer in total', async () => {
    fake.postRespondsWith = '500-after-create';
    const { bill, proposal } = await mason();
    await run('mason', { kind: 'approve', proposalId: proposal.proposalId, proposalVersion: 1 });
    expect(ledger.confirmedTotal(bill.billId)).toBe(0);
    expect(store.unresolvedBankOperations()).toHaveLength(1);

    await service.reconcile('demo-house');
    expect(ledger.confirmedByBeneficiary(bill.billId)).toEqual({ mason: 4_800 });
    expect(fake.transfers).toHaveLength(1);
  });

  it('a request that never reached the bank stays unknown until the operator decides absence is trustworthy', async () => {
    fake.postRespondsWith = 'network-before';
    const { proposal } = await mason();
    await run('mason', { kind: 'approve', proposalId: proposal.proposalId, proposalVersion: 1 });
    await service.reconcile('demo-house');
    expect(store.unresolvedBankOperations().map((o) => o.status)).toEqual(['unknown']);
    expect(fake.transfers).toHaveLength(0);
  });

  it('seeding adopts the operator-created accounts and keeps them on repeat', async () => {
    const seeded = await service.seedDemoBanking(config);
    expect(seeded.members.map((m) => m.bankAccountId)).toEqual(['acct-mason', 'acct-alex', 'acct-jordan']);
    expect(seeded.householdAccountId).toBe('acct-house');
    expect(await service.seedDemoBanking(config)).toEqual(seeded);
  });
});

describe('runNessieSmoke', () => {
  const pair = { fromAccountId: 'acct-mason', toAccountId: 'acct-house' };

  it('passes every check against a well-behaved sandbox', async () => {
    const report = await runNessieSmoke(bankWith(), { ...pair, operationId: 'smoke-1' });
    expect(report.allPassed).toBe(true);
    expect(report.checks.map((c) => c.name)).toContain('balances move');
  });

  it('reports, rather than hides, a sandbox that ignores balances, omits the payee and truncates cents', async () => {
    fake.balancesMove = false;
    fake.echoPayee = false;
    const report = await runNessieSmoke(bankWith({ allowFractionalDollars: true }), { ...pair, amountCents: 125, operationId: 'smoke-2' });
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(report.allPassed).toBe(false);
    expect(byName['balances move'].passed).toBe(false);
    expect(byName['balances move'].detail).toContain('cannot be used as proof of payment');
    expect(byName['transfer echoes the payee'].passed).toBe(false);
    expect(byName['transfer accepted'].passed).toBe(true);
  });

  it('reports a failing service without throwing and without leaking the key', async () => {
    const down = bankWith({ fetch: async () => { throw new TypeError(`fetch failed ?key=${KEY}`); } });
    const report = await runNessieSmoke(down, { ...pair, operationId: 'smoke-3' });
    expect(report.allPassed).toBe(false);
    expect(JSON.stringify(report)).not.toContain(KEY);
  });
});
