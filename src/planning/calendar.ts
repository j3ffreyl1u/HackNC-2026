// The approved plan as a calendar file: one event per stop. Nothing here needs a sign-in, and nothing about money
// or limits goes into it. The caller serves the text; people add it to their own calendar app.

export interface IcsStop {
  itemId: string;
  label: string;
  location: string;
  startAt: string;
  endAt: string;
}

export interface IcsPlan {
  candidateId: string;
  revision: number;
  title: string;
  itinerary: readonly IcsStop[];
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** An instant as the UTC form calendars expect: 20261114T130000Z. Undefined if the text is not a real time. */
function utc(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** RFC 5545 TEXT escaping: backslash first, then separators and line breaks. */
const escapeText = (text: string) =>
  text.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');

/** Lines are limited to 75 bytes; a longer one continues on the next line after a single space, never mid-character. */
function fold(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74; // a continuation line spends one byte on its leading space
    if (bytes + size > limit) {
      out.push(out.length === 0 ? current : ` ${current}`);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(out.length === 0 ? current : ` ${current}`);
  return out;
}

const uidPart = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, '-');

/**
 * Build the .ics text for an approved plan, or undefined if no stop has a usable start and end. A stop's UID does not
 * change between revisions and SEQUENCE carries the revision, so a calendar updates a stop in place when the plan changes.
 */
export function planToIcs(plan: IcsPlan, options: { now?: string } = {}): string | undefined {
  const stamp = utc(options.now ?? new Date().toISOString()) ?? utc(new Date().toISOString())!;
  const events: string[][] = [];
  for (const stop of plan.itinerary) {
    const start = utc(stop.startAt);
    const end = utc(stop.endAt);
    if (!start || !end || Date.parse(stop.endAt) <= Date.parse(stop.startAt)) continue;
    events.push([
      'BEGIN:VEVENT',
      `UID:${uidPart(plan.candidateId)}-${uidPart(stop.itemId)}@splitbot`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SEQUENCE:${plan.revision}`,
      `SUMMARY:${escapeText(stop.label)}`,
      ...(stop.location.trim() ? [`LOCATION:${escapeText(stop.location)}`] : []),
      `DESCRIPTION:${escapeText(`Part of ${plan.title}. Prices are estimates and nothing is booked.`)}`,
      'END:VEVENT',
    ]);
  }
  if (events.length === 0) return undefined;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Trip agent//Group trip plan//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(plan.title)}`, ...events.flat(), 'END:VCALENDAR'];
  return `${lines.flatMap(fold).join('\r\n')}\r\n`;
}
