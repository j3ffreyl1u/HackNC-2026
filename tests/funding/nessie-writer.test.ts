import { describe, expect, it } from 'vitest';
import { createNessieWriter } from '../../src/funding/nessie-writer.js';

describe('the Nessie sandbox writer', () => {
  it('only talks to the sandbox over HTTPS and returns the id of what it created', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetcher = (async (url: URL, init: RequestInit) => { calls.push({ url: String(url), method: init.method ?? 'GET' }); return new Response(JSON.stringify({ objectCreated: { _id: 'x1' } }), { status: 201 }); }) as typeof fetch;
    const writer = createNessieWriter({ baseUrl: 'https://api.nessieisreal.com', apiKey: 'k' }, fetcher);
    expect(await writer.createAccount('Mason')).toBe('x1');
    expect(await writer.postPurchase('acct', 'merchant', 60, 'SIMULATED trip purchase: gas', '2026-10-11')).toBe('x1');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'POST']);
    expect(() => createNessieWriter({ baseUrl: 'http://insecure.example', apiKey: 'k' })).toThrow(/HTTPS/);
  });
});
