import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createDispatcher } from './delivery';
import type { Alert, Config, Logger } from './types';
import { openManagedStore, WebStateError } from './web-store';
export { loadManagedConfig } from './web-store';

const MAX_BODY_BYTES = 1_048_576;
const MAX_TEST_TIMEOUT_MS = 5_000;
const APPLY_FAILURE = 'Settings are saved, but monitoring could not start. Check PM2 and save again to retry.';

export interface RuntimeStatus {
  readonly running: boolean;
  readonly message?: string;
}

export interface WebServerOptions {
  readonly statePath: string;
  readonly port?: number;
  readonly logger: Logger;
  readonly initial?: { config: unknown; secrets: NodeJS.ProcessEnv };
  readonly onApply?: (config: Config) => Promise<void>;
  readonly getRuntimeStatus?: () => RuntimeStatus;
}

function respond(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new WebStateError('Use application/json for this request.', 415);
  }
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) throw new WebStateError('Request exceeds the 1 MiB limit.', 413);
  const parts: Buffer[] = [];
  let length = 0;
  // Event-based reading avoids destroying the socket before an oversized response can be sent.
  return await new Promise((resolve, reject) => {
    let done = false;
    request.on('data', (chunk: Buffer) => {
      if (done) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        done = true;
        reject(new WebStateError('Request exceeds the 1 MiB limit.', 413));
        return;
      }
      parts.push(chunk);
    });
    request.on('end', () => {
      if (done) return;
      done = true;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid object');
        resolve(parsed as Record<string, unknown>);
      } catch { reject(new WebStateError('Request must contain a JSON object.')); }
    });
    request.on('error', () => {
      if (!done) { done = true; reject(new WebStateError('Request could not be read.')); }
    });
    request.on('aborted', () => {
      if (!done) { done = true; reject(new WebStateError('Request was interrupted.')); }
    });
  });
}

export async function startWebServer(options: WebServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  const port = options.port ?? 3100;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('UI port must be an integer between 0 and 65535.');
  const store = await openManagedStore(options.statePath, options.initial);
  const token = randomBytes(32).toString('hex');
  let runtime: RuntimeStatus = { running: false, message: 'Save a workflow to start monitoring.' };
  let applyFailed = false;
  const apply = async (config: Config): Promise<void> => {
    try {
      if (options.onApply !== undefined) {
        await options.onApply(config);
        runtime = { running: true };
      } else runtime = { running: false, message: 'Settings saved. Start the notifier to monitor processes.' };
      applyFailed = false;
    } catch {
      applyFailed = true;
      runtime = { running: false, message: APPLY_FAILURE };
      options.logger('error', 'Settings saved but the monitoring runtime could not start');
    }
  };
  const configured = store.resolvedConfig();
  const state = () => {
    let status = runtime;
    if (!applyFailed && options.getRuntimeStatus !== undefined) {
      try {
        // Runtime callback messages may contain credentials from third-party errors.
        const current = options.getRuntimeStatus();
        status = current.running ? { running: true } : { running: false, message: store.snapshot().config === null
          ? 'Save a workflow to start monitoring.' : 'Monitoring is not running. Save settings to retry.' };
      } catch { status = { running: false, message: 'Monitoring status is unavailable. Save settings to retry.' }; }
    }
    return { ...store.snapshot(), runtime: status };
  };
  let shuttingDown = false;
  const shutdown = new AbortController();
  let pending: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    if (shuttingDown) return Promise.reject(new WebStateError('The local UI is shutting down.', 503));
    const result = pending.then(() => {
      if (shuttingDown) throw new WebStateError('The local UI is shutting down.', 503);
      return action();
    });
    pending = result.catch(() => undefined);
    return result;
  };
  let origin = '';
  let hosts = new Set<string>();
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const handle = async (): Promise<void> => {
      if (shuttingDown) throw new WebStateError('The local UI is shutting down.', 503);
      if (!request.headers.host || !hosts.has(request.headers.host)) throw new WebStateError('Invalid request host.', 403);
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new WebStateError('Invalid request path.');
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const expectedOrigin = `http://${request.headers.host}`;
        if ((request.headers.origin !== undefined && request.headers.origin !== expectedOrigin) ||
            (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))) {
          throw new WebStateError('Cross-origin API requests are not allowed.', 403);
        }
        const supplied = request.headers['x-notifier-token'];
        if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
          throw new WebStateError('Open the complete local UI link printed when the server started.', 401);
        }
        if (request.method === 'GET' && url.pathname === '/api/state') {
          respond(response, 200, await serial(async () => state()));
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/config') {
          const input = await body(request);
          if (typeof input.revision !== 'string' || !Object.hasOwn(input, 'config') || Object.keys(input).some(key => !['revision', 'config', 'secrets'].includes(key))) {
            throw new WebStateError('Provide a revision, configuration, and credential updates.');
          }
          const saved = await serial(async () => {
            const config = await store.save(input.revision as string, input.config, input.secrets ?? {});
            await apply(config);
            return { ...state(), message: applyFailed ? APPLY_FAILURE : 'Settings saved.' };
          });
          respond(response, 200, saved);
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/test') {
          const input = await body(request);
          if (typeof input.destination !== 'string' || Object.keys(input).some(key => key !== 'destination')) {
            throw new WebStateError('Select one saved notification channel to test.');
          }
          await serial(async () => {
            const config = store.resolvedConfig();
            const destination = config?.destinations.find(item => item.id === input.destination && item.enabled);
            if (config === null || !destination) throw new WebStateError('Select an enabled channel from the saved settings.');
            const dispatcher = createDispatcher({
              delivery: { ...config.delivery, batchIntervalMs: 0, maxAttempts: 1, timeoutMs: Math.min(config.delivery.timeoutMs, MAX_TEST_TIMEOUT_MS) },
              destinations: [destination],
              routes: [{ destinations: [destination.id], events: ['notifier.test'], processes: ['*'], excludeProcesses: [], namespaces: ['*'], excludeNamespaces: [], severities: ['info'], scope: 'all' }],
            }, options.logger, {
              fetch: (url, init) => fetch(url, {
                ...init,
                signal: AbortSignal.any([shutdown.signal, ...(init?.signal ? [init.signal] : [])]),
              }),
            });
            const alert: Alert = {
              id: randomUUID(), type: 'notifier.test', severity: 'info', timestamp: new Date().toISOString(),
              hostname: config.hostname, environment: config.environment,
              message: 'PM2 notifier test: this notification channel is connected.', details: { scope: 'host' },
            };
            dispatcher.enqueue(alert);
            try { await dispatcher.close(); }
            catch { throw new WebStateError('The channel did not accept the test notification. Check its credentials and try again.', 502); }
          });
          respond(response, 200, { message: 'Test notification accepted by the saved channel.' });
          return;
        }
        throw new WebStateError('API endpoint or method not found.', 404);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new WebStateError('Method not allowed.', 405);
      const assets: Record<string, readonly [string, string]> = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
        '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
      };
      const asset = assets[url.pathname];
      if (!asset || !Object.hasOwn(assets, url.pathname)) throw new WebStateError('Page not found.', 404);
      let contents: Buffer;
      try { contents = await readFile(join(__dirname, 'web', asset[0])); }
      catch { throw new WebStateError('UI assets are unavailable. Build the application and restart.', 500); }
      response.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': contents.length });
      response.end(request.method === 'HEAD' ? undefined : contents);
    };
    void handle().catch(error => {
      if (response.headersSent || response.destroyed) return;
      const known = error instanceof WebStateError;
      if (!known) options.logger('error', 'Local UI request failed');
      respond(response, known ? error.status : 500, { message: known ? error.message : 'The local UI request could not be completed.' });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('Cannot start the local UI. Check that its port is available.')));
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { reject(new Error('Cannot determine the local UI address.')); return; }
      origin = `http://127.0.0.1:${address.port}`;
      hosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
      resolve();
    });
  });
  // Acquire the listening port first: a conflicting UI must not start a second monitor.
  if (configured !== null) await apply(configured);
  let closing: Promise<void> | undefined;
  return {
    url: `${origin}/#token=${token}`,
    close() {
      shuttingDown = true;
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        shutdown.abort();
        // An unfinished browser request must not consume PM2's shutdown budget.
        server.closeAllConnections();
        await stopped;
        // Preserve completion of a save/apply already in progress; queued work is rejected.
        await pending;
      })();
      return closing;
    },
  };
}
