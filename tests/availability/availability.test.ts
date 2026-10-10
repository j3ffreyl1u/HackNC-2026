import { describe, expect, it } from 'vitest';
import {
  AvailabilityUnavailableError,
  createGoogleFreeBusyProvider,
  createManualAvailabilityProvider,
  suggestFreeWindows,
} from '../../src/availability/index.js';

describe('manual availability provider', () => {
  it('returns only busy intervals overlapping the range, and nothing for unknown members', async () => {
    const p = createManualAvailabilityProvider();
    p.setBusy('mason', [
      { start: '2026-10-10T09:00:00-04:00', end: '2026-10-10T17:00:00-04:00' },
      { start: '2026-10-20T09:00:00-04:00', end: '2026-10-20T10:00:00-04:00' },
    ]);
    const got = await p.getBusyIntervals('mason', '2026-10-09T00:00:00-04:00', '2026-10-12T00:00:00-04:00');
    expect(got).toHaveLength(1);
    expect(await p.getBusyIntervals('alex', '2026-10-09T00:00:00-04:00', '2026-10-12T00:00:00-04:00')).toEqual([]);
    expect(p.has('mason')).toBe(true);
    expect(p.has('alex')).toBe(false); // "no data" is distinguishable from "free"
  });
});

describe('suggestFreeWindows', () => {
  const tz = 'America/New_York';
  it('finds runs of whole free days and respects the timezone', () => {
    const busy = [
      { start: '2026-10-16T09:00:00-04:00', end: '2026-10-16T17:00:00-04:00' }, // Fri busy
      { start: '2026-10-21T22:00:00-04:00', end: '2026-10-22T00:00:00-04:00' }, // ends at local midnight: Wed only
    ];
    expect(suggestFreeWindows(busy, '2026-10-15', '2026-10-22', tz)).toEqual([
      { start: '2026-10-15', end: '2026-10-15' },
      { start: '2026-10-17', end: '2026-10-20' },
      { start: '2026-10-22', end: '2026-10-22' },
    ]);
    expect(suggestFreeWindows(busy, '2026-10-15', '2026-10-22', tz, 2)).toEqual([{ start: '2026-10-17', end: '2026-10-20' }]);
  });
});

describe('google free/busy provider', () => {
  const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('sends the token in a header only and parses busy blocks', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = createGoogleFreeBusyProvider({
      getAccessToken: async () => 'TOKEN',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(JSON.stringify({ calendars: { primary: { busy: [{ start: '2026-10-16T13:00:00Z', end: '2026-10-16T14:00:00Z' }, { start: 5 }] } } }));
      }) as unknown as typeof fetch,
    });
    expect(await p.getBusyIntervals('mason', '2026-10-15T00:00:00Z', '2026-10-20T00:00:00Z')).toEqual([{ start: '2026-10-16T13:00:00Z', end: '2026-10-16T14:00:00Z' }]);
    expect(seen!.url).not.toContain('TOKEN');
    expect(String(seen!.init.body)).not.toContain('TOKEN');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer TOKEN');
  });

  it('fails as unavailable (so callers fall back to manual dates) instead of returning empty "free" time', async () => {
    const cases: Array<[string, typeof fetch, () => Promise<string | null>]> = [
      ['not connected', ok({}), async () => null],
      ['http error', ok({}, 403), async () => 't'],
      ['calendar error', ok({ calendars: { primary: { errors: [{ reason: 'notFound' }] } } }), async () => 't'],
      ['no calendar', ok({}), async () => 't'],
      ['network', (async () => { throw new Error('net'); }) as unknown as typeof fetch, async () => 't'],
    ];
    for (const [, fetchImpl, getAccessToken] of cases) {
      const p = createGoogleFreeBusyProvider({ getAccessToken, fetchImpl });
      await expect(p.getBusyIntervals('m', '2026-10-15T00:00:00Z', '2026-10-20T00:00:00Z')).rejects.toBeInstanceOf(AvailabilityUnavailableError);
    }
  });
});
