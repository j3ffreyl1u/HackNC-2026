import { describe, expect, it } from 'vitest';
import { createNessieWriter, DEFAULT_STEPS, runDemoSequence, type NessieWriter } from '../../src/funding/demo-sequence.js';
import type { Purchase } from '../../src/planning/funding.js';

/** A tiny pretend Nessie: the writer stores purchases, the reader reads them back the way the real one does. */
function fakeBank() {
  const rows: Array<{ accountId: string; merchantId: string; dollars: number }> = [];
  let n = 0;
  const writer: NessieWriter = {
    createAccount: async (label) => `acct-${label}-${++n}`,
    createMerchant: async (category) => `m-${category}`,
    postPurchase: async (accountId, merchantId, dollars) => { rows.push({ accountId, merchantId, dollars }); return `p${rows.length}`; },
  };
  return { rows, writer };
}

describe('the bank walk-through', () => {
  it('lists empty accounts, posts each purchase and reads the accounts back after each, then settles up', async () => {
    const { rows, writer } = fakeBank();
    const accounts: Record<string, string> = { jeffrey: 'old-j', mason: 'old-m' };
    const merchantCategories: Record<string, string> = {};
    const reader = { read: async () => ({ purchases: rows.map((r, i): Purchase => ({ id: `p${i}`, memberId: Object.entries(accounts).find(([, a]) => a === r.accountId)![0], amountDollars: r.dollars, status: 'completed', category: merchantCategories[r.merchantId] })) }) };
    const sent: string[] = [];
    const waits: number[] = [];
    await runDemoSequence({ writer, reader, accounts, merchantCategories }, {
      memberIds: ['jeffrey', 'mason'],
      nameOf: (id) => (id === 'jeffrey' ? 'Jeffrey' : 'Mason'),
      send: async (text) => { sent.push(text); },
      settleUp: async () => 'Trip wrap-up: Jeffrey sends Mason $45.',
      sleep: async (ms) => { waits.push(ms); },
      today: () => '2026-10-11',
      steps: [
        { memberId: 'mason', category: 'hotel', dollars: 110, what: 'the hotel', delayMs: 3000 },
        { memberId: 'jeffrey', category: 'gas', dollars: 60, what: 'gas', delayMs: 1000 },
        { memberId: 'jeffrey', category: 'restaurant', dollars: 48, what: 'dinner', delayMs: 2000 },
        { memberId: 'mason', category: 'parks', dollars: 40, what: 'park tickets', delayMs: 2000 },
      ],
    });
    expect(accounts.jeffrey).toMatch(/^acct-Jeffrey/);   // fresh accounts, so every run starts at zero
    expect(sent[0]).toMatch(/Jeffrey: no transactions yet\nMason: no transactions yet/);
    expect(sent[1]).toMatch(/New transaction: Mason paid \$110 for the hotel\.\nJeffrey: no transactions yet\nMason: \$110 hotel/);
    expect(sent[2]).toMatch(/Jeffrey paid \$60 for gas\.\nJeffrey: \$60 gas\nMason: \$110 hotel/);
    expect(sent[3]).toMatch(/Jeffrey paid \$48 for dinner\.\nJeffrey: \$60 gas, \$48 food/);
    expect(sent[4]).toMatch(/Mason paid \$40 for park tickets\.\nJeffrey: \$60 gas, \$48 food\nMason: \$110 hotel, \$40 park tickets/);
    expect(sent[5]).toMatch(/^Final transactions:\nJeffrey: .*\nMason: .*\nFood stays personal/);
    expect(sent[6]).toBe('Trip wrap-up: Jeffrey sends Mason $45.');
    expect(waits).toEqual([3000, 1000, 2000, 2000, 2000, 1500]);
    expect(rows).toHaveLength(4);
  });

  it('defaults to hotel, gas, food and one more bill, in that order', () => {
    expect(DEFAULT_STEPS(['jeffrey', 'mason']).map((s) => [s.memberId, s.category, s.dollars])).toEqual([['mason', 'hotel', 110], ['jeffrey', 'gas', 60], ['jeffrey', 'restaurant', 48], ['mason', 'parks', 40]]);
  });

  it('only talks to the sandbox over HTTPS and uses the key as a query parameter', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetcher = (async (url: URL, init: RequestInit) => { calls.push({ url: String(url), method: init.method ?? 'GET' }); return new Response(JSON.stringify({ objectCreated: { _id: 'x1' } }), { status: 201 }); }) as typeof fetch;
    const writer = createNessieWriter({ baseUrl: 'https://api.nessieisreal.com', apiKey: 'k' }, fetcher);
    expect(await writer.createAccount('Mason')).toBe('x1');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
    expect(() => createNessieWriter({ baseUrl: 'http://insecure.example', apiKey: 'k' })).toThrow(/HTTPS/);
  });
});
