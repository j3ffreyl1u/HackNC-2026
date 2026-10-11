import { sanitizeRetrievedText } from './evidence.js';
import { EvidenceStore } from './grounding.js';
import type { Priced } from './pricing.js';
import type { ResearchOption, ResearchRequest } from './types.js';

// Real lodging prices from Google Hotels through SerpApi (engine=google_hotels). One search per option returns named
// hotels with a nightly rate for the group's actual dates. The arithmetic stays in code, every figure it rests on is
// recorded as cited evidence, and a failure never invents a price: the caller falls back to the web-search lookup,
// then to a labelled typical cost.

const ENDPOINT = 'https://serpapi.com/search.json';
const DEFAULT_TIMEOUT_MS = 20_000;
/** Listed nightly rates outside this range are ads, typos or a currency problem, not a place to stay. */
const MIN_NIGHTLY_CENTS = 2_000;
const MAX_NIGHTLY_CENTS = 200_000;
const SLEEPS_PER_ROOM = 2;
/** Listed rates often leave out taxes and fees. */
const TAX_AND_FEES = 1.15;
const MAX_CITED = 3;

export interface SerpApiConfig {
  apiKey: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Searches this process may spend before it stops asking (default 30). SerpApi plans are small, and a re-search must not burn them. */
  maxSearches?: number;
  /** How long an identical search (same place, dates and group) is reused, in ms (default 12 hours). 0 turns the cache off. */
  cacheMs?: number;
  now?: () => number;
}

export interface HotelQuery { query: string; checkIn: string; checkOut: string; adults: number }
export interface Hotel { name: string; nightlyCents: number; url?: string; rating?: number }
export interface HotelResults { hotels: Hotel[]; /** The Google Hotels page for the same search, for a source link when a hotel has none. */ searchUrl?: string }
export type FindHotels = (query: HotelQuery) => Promise<HotelResults | undefined>;

/** Read the key from an environment object. `undefined` means hotel prices are not configured. */
export function serpApiConfigFromEnv(env: Record<string, string | undefined>): SerpApiConfig | undefined {
  const apiKey = env.SERPAPI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const max = Number(env.SERPAPI_MAX_SEARCHES);
  return { apiKey, ...(Number.isInteger(max) && max >= 0 ? { maxSearches: max } : {}) };
}

const isUrl = (text: unknown): text is string => {
  if (typeof text !== 'string') return false;
  try { return new URL(text).protocol === 'https:'; } catch { return false; }
};

function nightlyCents(property: Record<string, any>): number | undefined {
  const rate = property.rate_per_night;
  let dollars: unknown = rate?.extracted_lowest;
  if (typeof dollars !== 'number' && typeof rate?.lowest === 'string') dollars = Number(rate.lowest.replace(/[^0-9.]/g, ''));
  if (typeof dollars !== 'number' || !Number.isFinite(dollars)) return undefined;
  const cents = Math.round(dollars * 100);
  return cents >= MIN_NIGHTLY_CENTS && cents <= MAX_NIGHTLY_CENTS ? cents : undefined;
}

/** A Google Hotels search for one stay. Throws a message that never contains the key. */
export function createSerpApiHotels(config: SerpApiConfig): FindHotels {
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const cacheMs = config.cacheMs ?? 12 * 3_600_000;
  const cache = new Map<string, { at: number; value: Promise<HotelResults | undefined> }>();
  let spent = 0;
  return (q) => {
    // The same place, dates and group size always gives the same answer, so a re-search (a changed cap, a retry) costs nothing.
    const key = JSON.stringify([q.query.toLowerCase(), q.checkIn, q.checkOut, q.adults]);
    const hit = cache.get(key);
    if (hit && cacheMs > 0 && now() - hit.at < cacheMs) return hit.value;
    if (spent >= (config.maxSearches ?? 30)) return Promise.reject(new Error('Hotel price search skipped: this run has used its search allowance.'));
    spent += 1;
    const value = search(q);
    if (cacheMs > 0) {
      cache.set(key, { at: now(), value });
      value.catch(() => cache.delete(key));   // a failure is not remembered, so a retry can succeed
    }
    return value;
  };

  async function search(q: HotelQuery): Promise<HotelResults | undefined> {
    const url = new URL(ENDPOINT);
    for (const [k, v] of Object.entries({ engine: 'google_hotels', q: q.query, check_in_date: q.checkIn, check_out_date: q.checkOut, adults: String(q.adults), currency: 'USD', gl: 'us', hl: 'en', api_key: config.apiKey })) url.searchParams.set(k, v);
    let body: any;
    try {
      const res = await fetchImpl(url.href, { signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (error) {
      // The request URL carries the key, so nothing from the original error (message, stack, cause) is passed on.
      throw new Error(`Hotel price search failed (${error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : 'network error or timeout'}).`);
    }
    if (typeof body?.error === 'string') {
      // "Google hasn't returned any results" is an answer; anything else (quota, key, plan) is a failure.
      if (/hasn'?t returned any results|no results/i.test(body.error)) return undefined;
      throw new Error('Hotel price search was refused by the service (check the key and plan).');
    }
    const hotels: Hotel[] = [];
    for (const p of Array.isArray(body?.properties) ? body.properties : []) {
      const cents = nightlyCents(p);
      if (typeof p?.name !== 'string' || cents === undefined) continue;
      hotels.push({
        name: sanitizeRetrievedText(p.name, 80),
        nightlyCents: cents,
        ...(isUrl(p.link) ? { url: p.link } : {}),
        ...(typeof p.overall_rating === 'number' ? { rating: p.overall_rating } : {}),
      });
    }
    if (hotels.length === 0) return undefined;
    const searchUrl = body?.search_metadata?.google_hotels_url;
    return { hotels, ...(isUrl(searchUrl) ? { searchUrl } : {}) };
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const localDate = (instant: string | number, timeZone: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

/** Check-in is the first night of the group's common window; check-out follows the trip length. Past dates cannot be searched. */
export function stayDates(window: { startAt: string; endAt: string } | undefined, nights: number, timeZone = 'America/New_York', today = localDate(Date.now(), timeZone)): { checkIn: string; checkOut: string } | undefined {
  if (!window || !Number.isInteger(nights) || nights < 1 || Number.isNaN(Date.parse(window.startAt))) return undefined;
  const checkIn = localDate(window.startAt, timeZone);
  if (checkIn < today) return undefined;
  const checkOut = new Date(Date.parse(`${checkIn}T00:00:00Z`) + nights * 86_400_000).toISOString().slice(0, 10);
  return { checkIn, checkOut };
}

/**
 * Turn listings into a price range for the whole group: rooms (two people each) x nights x the nightly rate. The low end is
 * the cheapest listing; the high end is the upper quarter of listings plus taxes and fees, so it is deliberately generous.
 * Returns undefined, never zero, when nothing can be cited.
 */
export function lodgingFromHotels(found: HotelResults, nights: number, groupSize: number, checkIn: string, store: EvidenceStore): Priced | undefined {
  const hotels = [...found.hotels].sort((a, b) => a.nightlyCents - b.nightlyCents);
  if (hotels.length === 0) return undefined;
  const rooms = Math.ceil(groupSize / SLEEPS_PER_ROOM);
  const stay = (nightly: number) => nightly * rooms * nights;
  const upper = hotels[Math.max(0, Math.ceil(hotels.length * 0.75) - 1)]!;
  const cited = [...new Set([hotels[0]!, hotels[Math.floor((hotels.length - 1) / 2)]!, upper])].slice(0, MAX_CITED);
  const stayLabel = `${dayLabel(checkIn)}, ${nights} night${nights === 1 ? '' : 's'}`;
  const evidenceIds: string[] = [];
  for (const h of cited) {
    const url = h.url ?? found.searchUrl;
    if (!url) continue;
    const id = store.add({ url, title: h.url ? undefined : 'Google Hotels', start: 0, end: 0 }, `${h.name} lists $${(h.nightlyCents / 100).toFixed(0)} per night for a stay from ${stayLabel} (Google Hotels, via SerpApi)`, 'A listed rate at the time of the search, not a booking: availability and the final price at checkout can differ.');
    if (id) evidenceIds.push(id);
  }
  if (evidenceIds.length === 0) return undefined;
  return {
    lowCents: stay(hotels[0]!.nightlyCents),
    highCents: Math.ceil(stay(upper.nightlyCents) * TAX_AND_FEES),
    evidenceIds,
    assumption: `Lodging uses Google Hotels listings for your dates (${stayLabel}), ${rooms} room${rooms === 1 ? '' : 's'} for ${groupSize} people, the cheapest listing as the low end and the upper quarter of listings plus ${Math.round((TAX_AND_FEES - 1) * 100)}% for taxes and fees as the high end.`,
  };
}

/**
 * The place to search. The group's chosen destination wins: they sleep in that town, and every option there then shares one
 * (cached) search. Without one, the first named stop, else the option's region. A trail or park as the first stop finds no hotels.
 */
function searchPlace(option: ResearchOption, request: ResearchRequest): string {
  return request.destination?.trim() || option.stops.map((s) => s.location.trim()).find((l) => l.length > 0) || option.region;
}

/** What `priceOption` calls for lodging: dates from the group's window, one Google Hotels search per option. */
export function createLodgingLookup(find: FindHotels, timeZone = 'America/New_York') {
  return async (option: ResearchOption, request: ResearchRequest, store: EvidenceStore): Promise<Priced | undefined> => {
    if (request.nights === undefined || request.groupSize === undefined) return undefined;
    const dates = stayDates(request.window, request.nights, timeZone);
    if (!dates) return undefined;
    const found = await find({ query: `Hotels in ${searchPlace(option, request)}`, checkIn: dates.checkIn, checkOut: dates.checkOut, adults: Math.min(request.groupSize, SLEEPS_PER_ROOM) });
    return found ? lodgingFromHotels(found, request.nights, request.groupSize, dates.checkIn, store) : undefined;
  };
}
