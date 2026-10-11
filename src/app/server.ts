import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Repository } from '../contracts/index.js';
import type { LiveResearchDisplay } from './live-research.js';
import type { FundService } from '../funding/service.js';
import { toPlanningCandidate } from './planning-adapter.js';
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
  if (request.method === 'GET' && url.pathname === '/') {
    await sendFile(response, resolve(webRoot, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  if (request.method === 'GET' && ['/app.js', '/reef.js', '/styles.css', '/aero-ocean.jpg', '/aero-meadow.webp', '/aero-globe.png', '/aero-leaves.png', '/aero-bubble.png', '/aero-monitor.png', '/aero-display.ttf', '/reef-3d.js', '/vendor/three.module.js', '/vendor/three.core.min.js', '/vendor/GLTFLoader.js', '/vendor/BufferGeometryUtils.js', '/models/fish.glb', '/models/clownfish.glb', '/models/blue-tang.glb', '/models/yellow-tang.glb', '/models/dolphin.glb', '/vendor/SkeletonUtils.js'].includes(url.pathname)) {
    const name = url.pathname.slice(1);
    await sendFile(response, resolve(webRoot, name), name.endsWith('.png') ? 'image/png' : name.endsWith('.glb') ? 'model/gltf-binary' : name.endsWith('.ttf') ? 'font/ttf' : name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.webp') ? 'image/webp' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
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
  'content-security-policy': "default-src 'self'; connect-src 'self' blob:; img-src 'self' data: blob:; style-src 'self'; script-src 'self'",
};

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
