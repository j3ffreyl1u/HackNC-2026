/** Decimal-string dollar parsing. Never multiplies binary floats. */
export function parseDollarsToCents(input: string | number): number | null {
  const raw = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : input;
  const s = raw.trim().replace(/^\$\s*/, '').replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function formatCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rem = String(cents % 100).padStart(2, '0');
  return `$${whole.toLocaleString('en-US')}.${rem}`;
}

export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
