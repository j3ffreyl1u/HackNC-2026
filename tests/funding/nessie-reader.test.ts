import { describe, expect, it, vi } from 'vitest';
import { createNessieReader } from '../../src/funding/nessie-reader.js';

describe('read-only Nessie reader', () => {
  it('only reaches the two GET transaction endpoints and maps configured merchant categories', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      const path = new URL(String(input)).pathname;
      expect(path).toMatch(/^\/accounts\/account\/(deposits|purchases)$/);
      const body = path.endsWith('/deposits') ? [{ _id: 'd', amount: 90, description: 'member=alex;rev=3', status: 'completed' }]
        : path.endsWith('/purchases') ? [{ _id: 'p', amount: 10, merchant_id: 'm', status: 'pending' }]
        : { category: 'gas' };
      return new Response(JSON.stringify(body));
    });
    const reader = createNessieReader({ baseUrl: 'https://example.com', apiKey: 'secret', accountId: 'account', merchantCategories: { m: 'gas' } }, fetcher);
    expect(Object.keys(reader)).toEqual(['read']);
    expect(await reader.read()).toEqual({ deposits: [{ id: 'd', amountDollars: 90, description: 'member=alex;rev=3', status: 'completed' }], purchases: [{ id: 'p', amountDollars: 10, category: 'gas', status: 'pending' }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not disclose credentials or fall back on failed reads', async () => {
    const reader = createNessieReader({ baseUrl: 'https://example.com', apiKey: 'secret', accountId: 'a' }, vi.fn(async () => { throw new Error('secret'); }));
    await expect(reader.read()).rejects.toThrow('Nessie read unavailable');
  });
  it('rejects malformed money and missing status instead of crediting a deposit', async () => {
    const reader = createNessieReader({ baseUrl: 'https://example.com', apiKey: 'secret', accountId: 'a' }, vi.fn(async () => new Response(JSON.stringify([{ _id: 'x', amount: 2.5 }]))));
    await expect(reader.read()).rejects.toThrow('Invalid Nessie transaction');
  });
});
