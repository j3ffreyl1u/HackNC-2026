import { describe, expect, it, vi } from 'vitest';
import { createNessieReader } from '../../src/funding/nessie-reader.js';

const accounts = { mason: 'acct-m', alex: 'acct-a', jordan: 'acct-j' };

describe('read-only Nessie reader (one account per friend)', () => {
  it('only makes GET requests, one purchases read per friend, and tags each purchase with whose account it came from', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      const path = new URL(String(input)).pathname;
      calls.push(path);
      expect(path).toMatch(/^\/accounts\/acct-[maj]\/purchases$/);
      const rows: Record<string, unknown[]> = {
        '/accounts/acct-m/purchases': [{ _id: 'p1', amount: 110, merchant_id: 'hotel-m', status: 'completed', purchase_date: '2026-11-14' }],
        '/accounts/acct-a/purchases': [{ _id: 'p2', amount: 60, merchant_id: 'gas-m', status: 'completed', purchase_date: '2026-11-14T10:00:00Z' }],
        '/accounts/acct-j/purchases': [],
      };
      return new Response(JSON.stringify(rows[path]));
    });
    const reader = createNessieReader({ baseUrl: 'https://example.com', apiKey: 'secret', accounts, merchantCategories: { 'hotel-m': 'hotel', 'gas-m': 'gas' } }, fetcher);
    expect(Object.keys(reader)).toEqual(['read']);
    expect(await reader.read()).toEqual({ purchases: [
      { id: 'p1', memberId: 'mason', amountDollars: 110, status: 'completed', category: 'hotel', date: '2026-11-14' },
      { id: 'p2', memberId: 'alex', amountDollars: 60, status: 'completed', category: 'gas', date: '2026-11-14' },
    ] });
    expect(calls.sort()).toEqual(['/accounts/acct-a/purchases', '/accounts/acct-j/purchases', '/accounts/acct-m/purchases']);
  });
  it('leaves a merchant it has no category for unclassified, never guessed', async () => {
    const reader = createNessieReader({ baseUrl: 'https://example.com', apiKey: 'k', accounts: { mason: 'a' } }, vi.fn(async () => new Response(JSON.stringify([{ _id: 'x', amount: 5, merchant_id: 'unknown', status: 'completed' }]))));
    expect((await reader.read()).purchases[0]!.category).toBeUndefined();
  });
  it('does not disclose credentials or fall back when any read fails', async () => {
    const reader = createNessieReader({ baseUrl: 'https://example.com', apiKey: 'secret', accounts }, vi.fn(async () => { throw new Error('secret'); }));
    const error = await reader.read().catch((e: Error) => e);
    expect((error as Error).message).toMatch(/Nessie read unavailable/); expect(String((error as Error).message + (error as Error).stack)).not.toMatch(/secret/);
  });
  it('fails the whole read if one friend\'s account cannot be read, instead of splitting on partial data', async () => {
    let n = 0;
    const reader = createNessieReader({ baseUrl: 'https://example.com', apiKey: 'k', accounts }, vi.fn(async () => (++n === 2 ? new Response('no', { status: 500 }) : new Response('[]'))));
    await expect(reader.read()).rejects.toThrow('Nessie read unavailable');
  });
  it('rejects malformed money and missing status instead of counting a purchase', async () => {
    const reader = createNessieReader({ baseUrl: 'https://example.com', apiKey: 'k', accounts: { mason: 'a' } }, vi.fn(async () => new Response(JSON.stringify([{ _id: 'x', amount: 2.5, merchant_id: 'm' }]))));
    await expect(reader.read()).rejects.toThrow('Invalid Nessie transaction');
  });
  it('rejects a purchase with no merchant, and a base URL that is not clean HTTPS, and no accounts', async () => {
    const noMerchant = createNessieReader({ baseUrl: 'https://example.com', apiKey: 'k', accounts: { mason: 'a' } }, vi.fn(async () => new Response(JSON.stringify([{ _id: 'x', amount: 5, status: 'completed' }]))));
    await expect(noMerchant.read()).rejects.toThrow('no merchant ID');
    expect(() => createNessieReader({ baseUrl: 'http://example.com', apiKey: 'k', accounts })).toThrow('HTTPS');
    expect(() => createNessieReader({ baseUrl: 'https://example.com', apiKey: 'k', accounts: {} })).toThrow('one account for each friend');
  });
});
