import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { FinanceService, HouseholdConfig } from '../contracts/index.js';

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
async function body(req: IncomingMessage): Promise<unknown> {
  let raw = ''; for await (const part of req) raw += part;
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
        const householdId = decodeURIComponent(snapshot[1]);
        if (householdId !== options.config.householdId) return json(res, 404, { error: 'Household not found' });
        return json(res, 200, await options.finance.getSnapshot(householdId));
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/advance-cycle') {
        if (!options.demoMode) return json(res, 404, { error: 'Not found' });
        if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') return json(res, 404, { error: 'Not found' });
        const input = await body(req) as { householdId?: unknown; cycleId?: unknown };
        if (typeof input.householdId !== 'string' || typeof input.cycleId !== 'string') return json(res, 400, { error: 'householdId and cycleId are required strings' });
        if (input.householdId !== options.config.householdId) return json(res, 400, { error: 'Unknown household' });
        try { await options.finance.advanceDemoCycle(input.householdId, input.cycleId); return json(res, 200, { ok: true }); }
        catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : 'Cycle transition unavailable' }); }
      }
      const assetPath = normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (assetPath.startsWith('..')) return json(res, 404, { error: 'Not found' });
      const file = await readFile(join(options.webRoot ?? 'web', assetPath));
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      res.writeHead(200, { 'content-type': types[extname(filePath(assetPath))] ?? 'application/octet-stream' }); res.end(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json(res, 404, { error: 'Not found' });
      return json(res, 500, { error: 'Internal server error' });
    }
  });
}
function filePath(path: string): string { return path; }
