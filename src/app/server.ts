import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { FinanceService, HouseholdConfig } from '../contracts/index.js';

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error('Request body is too large');
  }
  return JSON.parse(raw || '{}');
}

export function createAppServer(options: { finance: FinanceService; config: HouseholdConfig; demoMode: boolean; webRoot?: string }): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return json(res, 200, { householdId: options.config.householdId, demoMode: options.demoMode });
      }
      const snapshot = url.pathname.match(/^\/api\/households\/([^/]+)\/snapshot$/);
      if (req.method === 'GET' && snapshot) {
        let householdId: string;
        try { householdId = decodeURIComponent(snapshot[1]); }
        catch { return json(res, 400, { error: 'Invalid household ID' }); }
        if (householdId !== options.config.householdId) return json(res, 404, { error: 'Household not found' });
        return json(res, 200, publicSnapshot(await options.finance.getSnapshot(householdId)));
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/advance-cycle') {
        if (!options.demoMode || !isLoopback(req.socket.remoteAddress)) return json(res, 404, { error: 'Not found' });
        let input: unknown;
        try { input = await readJson(req); }
        catch { return json(res, 400, { error: 'Request body must be valid JSON smaller than 16 KB' }); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json(res, 400, { error: 'Expected an object body' });
        const values = input as { householdId?: unknown; cycleId?: unknown };
        if (typeof values.householdId !== 'string' || typeof values.cycleId !== 'string' || !values.householdId || !values.cycleId) {
          return json(res, 400, { error: 'householdId and cycleId are required strings' });
        }
        if (values.householdId !== options.config.householdId) return json(res, 400, { error: 'Unknown household' });
        try {
          await options.finance.advanceDemoCycle(values.householdId, values.cycleId);
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 409, { error: error instanceof Error ? error.message : 'Cycle transition unavailable' });
        }
      }
      const assetPath = normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (assetPath === '..' || assetPath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return json(res, 404, { error: 'Not found' });
      const file = await readFile(join(options.webRoot ?? 'web', assetPath));
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      res.writeHead(200, { 'content-type': types[extname(assetPath)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json(res, 404, { error: 'Not found' });
      return json(res, 500, { error: 'Internal server error' });
    }
  });
}

/** Whitelist the browser DTO so accidental private fields from a service never cross HTTP. */
function publicSnapshot(snapshot: Awaited<ReturnType<FinanceService['getSnapshot']>>) {
  return {
    householdId: snapshot.householdId,
    cycleId: snapshot.cycleId,
    currency: snapshot.currency,
    balanceCents: snapshot.balanceCents,
    bills: snapshot.bills.map(({ billId, title, amountCents, dueDate, status }) => ({ billId, title, amountCents, dueDate, status })),
    contributions: snapshot.contributions.map(({ billId, userId, agreedCents, confirmedCents, coveredForUserId }) => ({
      billId, userId, agreedCents, confirmedCents,
      ...(coveredForUserId === undefined ? {} : { coveredForUserId }),
    })),
    debts: snapshot.debts.map(({ debtId, debtorId, creditorId, originalCents, remainingCents }) => ({ debtId, debtorId, creditorId, originalCents, remainingCents })),
    activity: snapshot.activity.map(({ activityId, occurredAt, description, status }) => ({ activityId, occurredAt, description, status })),
  };
}

function isLoopback(address?: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
