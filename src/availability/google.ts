/**
 * Google Calendar free/busy adapter (CALENDAR_MODE=google). Request/response shape follows
 * developers.google.com/workspace/calendar/api/v3/reference/freebusy/query. UNVERIFIED against a live
 * account: needs an OAuth access token with the calendar.freebusy scope per member. It reads busy blocks
 * only (no event titles), and it is optional: any failure is an AvailabilityUnavailableError so the caller
 * can fall back to manual dates. Tokens and calendar contents are never logged.
 */
import { AvailabilityUnavailableError, type AvailabilityProvider, type BusyInterval } from './index.js';

export interface GoogleFreeBusyOptions {
  /** Return the member's OAuth access token, or null if they have not connected a calendar. */
  getAccessToken(memberId: string): Promise<string | null>;
  calendarId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const ENDPOINT = 'https://www.googleapis.com/calendar/v3/freeBusy';

export function createGoogleFreeBusyProvider(opts: GoogleFreeBusyOptions): AvailabilityProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const calendarId = opts.calendarId ?? 'primary';
  return {
    async getBusyIntervals(memberId, from, to): Promise<BusyInterval[]> {
      const token = await opts.getAccessToken(memberId);
      if (!token) throw new AvailabilityUnavailableError('Calendar not connected');
      let res: Response;
      try {
        res = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ timeMin: from, timeMax: to, items: [{ id: calendarId }] }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch {
        throw new AvailabilityUnavailableError('Calendar request failed');
      }
      if (!res.ok) throw new AvailabilityUnavailableError(`Calendar request failed (HTTP ${res.status})`);
      const body = (await res.json().catch(() => null)) as { calendars?: Record<string, { busy?: unknown; errors?: unknown }> } | null;
      const cal = body?.calendars?.[calendarId];
      if (!cal || cal.errors) throw new AvailabilityUnavailableError('Calendar returned no usable free/busy data');
      if (!Array.isArray(cal.busy)) throw new AvailabilityUnavailableError('Calendar returned no usable free/busy data');
      const out: BusyInterval[] = [];
      for (const b of cal.busy as Array<{ start?: unknown; end?: unknown }>) {
        if (typeof b?.start === 'string' && typeof b?.end === 'string' && Number.isFinite(Date.parse(b.start)) && Number.isFinite(Date.parse(b.end))) {
          out.push({ start: b.start, end: b.end });
        }
      }
      return out;
    },
  };
}
