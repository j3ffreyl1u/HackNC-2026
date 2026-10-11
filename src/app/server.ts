import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Repository } from '../contracts/index.js';
import type { LiveResearchDisplay } from './live-research.js';
import type { FundService } from '../funding/service.js';
import { toPlanningCandidate } from './planning-adapter.js';
import { planToIcs } from '../planning/calendar.js';
import { outdoorSummary, drivingComparison } from '../planning/nature.js';

export interface HttpServerOptions {
  repository: Repository;
  webRoot?: string;
  researchDisplay?: LiveResearchDisplay;
  fundService?: FundService;
}

export interface LocalHttpServer {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

/** Loopback-only, read-only trip view. */
export function createHttpServer(options: HttpServerOptions): LocalHttpServer {
  const webRoot = resolve(options.webRoot ?? 'web');
  const server = createServer((request, response) => {
    void route(request, response, options, webRoot).catch(() => sendJson(response, 500, { error: 'Internal server error.' }));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 12_000;

  return {
    listen(port) {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('Could not determine local HTTP port.'));
            return;
          }
          resolveListen(address.port);
        });
      });
    },
    close: () => closeServer(server),
  };
}

async function route(request: IncomingMessage, response: ServerResponse, options: HttpServerOptions, webRoot: string): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const research = /^\/research\/([a-f0-9]{48})$/.exec(url.pathname);
  if (research && options.researchDisplay) {
    const token = research[1];
    if (!options.researchDisplay.has(token)) { sendJson(response, 404, { error: 'Research request expired. Ask again in chat.' }); return; }
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...securityHeaders, 'cache-control': 'no-store' });
      response.end('<!doctype html><html><body><h1>Live trip research</h1><p>This request uses Gemini Search. The answer is shown here once and is not saved to the trip.</p><form method="post"><button type="submit">Research this question</button></form></body></html>');
      return;
    }
    if (request.method === 'POST') {
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) { sendJson(response, 403, { error: 'Invalid request origin.' }); return; }
      try {
        const html = await options.researchDisplay.render(token);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        response.end(html);
      } catch { sendJson(response, 503, { error: 'Live research is unavailable. Ask again in chat to retry. No fixture answer was substituted.' }); }
      return;
    }
  }
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {   // HEAD too: link previews probe with it
    await sendFile(response, resolve(webRoot, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  if ((request.method === 'GET' || request.method === 'HEAD') && ['/app.js', '/reef.js', '/styles.css', '/aero-ocean.jpg', '/aero-meadow.webp'].includes(url.pathname)) {
    const name = basename(url.pathname);
    await sendFile(response, resolve(webRoot, name), name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.webp') ? 'image/webp' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
    return;
  }
  const fundMatch = /^\/api\/trips\/([^/]+)\/fund$/.exec(url.pathname);
  if (request.method === 'GET' && fundMatch) {
    const tripId = decodeURIComponent(fundMatch[1]);
    const state = await options.repository.loadTrip(tripId);
    if (!state) { sendJson(response, 404, { error: 'Trip not found.' }); return; }
    if (!options.fundService) { sendJson(response, 200, { status: 'disabled', revision: state.revision }); return; }
    try {
      const fund = await options.fundService.publicView(state);
      const current = await options.repository.loadTrip(tripId);
      if (current?.revision !== state.revision) { sendJson(response, 409, { error: 'Plan changed. Refresh the fund.' }); return; }
      sendJson(response, 200, fund);
    } catch { sendJson(response, 503, { status: 'unknown', error: 'Fund unavailable. No simulated data was substituted.' }); }
    return;
  }
  const icsMatch = /^\/api\/trips\/([^/]+)\/plan\.ics$/.exec(url.pathname);
  if (request.method === 'GET' && icsMatch) {
    const state = await options.repository.loadTrip(decodeURIComponent(icsMatch[1]));
    if (!state) { sendJson(response, 404, { error: 'Trip not found.' }); return; }
    const chosen = state.status === 'approved' ? state.candidates.find((c) => c.candidateId === state.selectedCandidateId && c.revision === state.revision) : undefined;
    const ics = chosen ? planToIcs({ candidateId: chosen.candidateId, revision: chosen.revision, title: chosen.title, itinerary: chosen.itinerary.map((i) => ({ itemId: i.itemId, label: i.label ?? i.location, location: i.location, startAt: i.startAt, endAt: i.endAt })) }) : undefined;
    if (!ics) { sendJson(response, 409, { error: 'There is no approved plan with times to add to a calendar yet.' }); return; }
    response.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="trip-plan.ics"', 'cache-control': 'no-store', ...securityHeaders });
    response.end(ics);
    return;
  }
  const match = /^\/api\/trips\/([^/]+)\/snapshot$/.exec(url.pathname);
  if (request.method === 'GET' && match) {
    const tripId = decodeURIComponent(match[1]);
    const snapshot = await options.repository.getPublicSnapshot(tripId);
    if (snapshot) {
      const candidates = snapshot.candidates.map(toPlanningCandidate);
      snapshot.nature = { summaries: candidates.map(outdoorSummary), comparison: drivingComparison(candidates)?.text };
    }
    sendJson(response, snapshot ? 200 : 404, snapshot ?? { error: 'Trip not found.' });
    return;
  }
  sendJson(response, 404, { error: 'Not found.' });
}

async function sendFile(response: ServerResponse, path: string, contentType: string): Promise<void> {
  try {
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache', ...securityHeaders });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'Page asset not found.' });
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders });
  response.end(JSON.stringify(value));
}

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
};

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
