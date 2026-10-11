import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Repository } from '../contracts/index.js';
import type { LiveResearchDisplay } from './live-research.js';

export interface HttpServerOptions {
  repository: Repository;
  webRoot?: string;
  researchDisplay?: LiveResearchDisplay;
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
  if (request.method === 'GET' && ['/app.js', '/styles.css', '/aero-landscape.png'].includes(url.pathname)) {
    const name = basename(url.pathname);
    await sendFile(response, resolve(webRoot, name), name.endsWith('.png') ? 'image/png' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
    return;
  }
  const match = /^\/api\/trips\/([^/]+)\/snapshot$/.exec(url.pathname);
  if (request.method === 'GET' && match) {
    const tripId = decodeURIComponent(match[1]);
    const snapshot = await options.repository.getPublicSnapshot(tripId);
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
