import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWebServer, type WebServerOptions } from '../src/web-server';
import type { RawConfig } from '../src/config';
import type { Config, Logger } from '../src/types';

const input = { destinations: [{ id: 'ops', format: 'generic', urlEnv: 'HOOK' }], routes: [{ destinations: ['ops'] }] };
const secrets = { HOOK: 'https://example.invalid/PRIVATE-URL' };
const logger: Logger = () => undefined;

interface State {
  revision: string;
  config: RawConfig | null;
  configuredSecrets: string[];
  runtime: { running: boolean; message?: string };
  message?: string;
}

async function fixture(options: Partial<WebServerOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pm2-notifier-web-server-'));
  const statePath = join(directory, 'private', 'settings.json');
  const server = await startWebServer({ statePath, port: 0, logger, ...options });
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
  const call = (path: string, data?: unknown, headers: Record<string, string> = {}) => fetch(`${url.origin}${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-Notifier-Token': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const getState = async (): Promise<State> => (await call('/api/state')).json() as Promise<State>;
  return { server, url, token, statePath, call, getState, cleanup: async () => { await server.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('API requires a fresh session token, exact loopback host and same-origin browser requests', async () => {
  const app = await fixture();
  try {
    assert.equal(app.url.hostname, '127.0.0.1');
    assert.match(app.token, /^[a-f0-9]{64}$/);
    assert.equal((await fetch(`${app.url.origin}/api/state`)).status, 401);
    assert.equal((await app.call('/api/state', undefined, { 'X-Notifier-Token': 'wrong' })).status, 401);
    assert.equal((await app.call('/api/state', undefined, { 'X-Notifier-Token': 'é'.repeat(64) })).status, 401);
    const blockedHeaders: Record<string, string>[] = [
      { Origin: 'https://attacker.invalid' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
    ];
    for (const headers of blockedHeaders) assert.equal((await app.call('/api/state', undefined, headers)).status, 403);
    assert.equal((await app.call('/api/state', undefined, { Origin: app.url.origin, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    const wrongHost = await new Promise<number>(resolve => {
      const req = httpRequest(`${app.url.origin}/api/state`, { headers: { Host: `attacker.invalid:${app.url.port}`, 'X-Notifier-Token': app.token } }, res => {
        res.resume(); resolve(res.statusCode!);
      });
      req.end();
    });
    assert.equal(wrongHost, 403);
    const response = await app.call('/api/state');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal((await app.call('/api/config')).status, 404);
    assert.equal((await app.call('/does-not-exist')).status, 404);
  } finally { await app.cleanup(); }
});

test('UI serves only its static assets with CSP and never exposes settings or session tokens', async () => {
  const app = await fixture({ initial: { config: input, secrets } });
  try {
    for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/theme.js', 'text/javascript'], ['/styles.css', 'text/css']]) {
      const response = await fetch(`${app.url.origin}${path}`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type')?.startsWith(type));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const contents = await response.text();
      assert.ok(!contents.includes(app.token));
      assert.ok(!contents.includes(secrets.HOOK));
      assert.ok(!response.headers.get('content-security-policy')?.includes('unsafe-inline'));
    }
    for (const path of ['/web-store.ts', '/settings.json', '/private/settings.json', '/%2e%2e/settings.json']) {
      assert.equal((await fetch(`${app.url.origin}${path}`)).status, 404);
    }
  } finally { await app.cleanup(); }
});

test('saving resolves credentials for runtime, hides values from API, and imports saved state on restart', async () => {
  const applied: Config[] = [];
  const app = await fixture({ onApply: async config => { applied.push(config); } });
  try {
    const initial = await app.getState();
    assert.equal(initial.config, null);
    assert.equal(initial.runtime.running, false);
    const response = await app.call('/api/config', { revision: initial.revision, config: input, secrets });
    assert.equal(response.status, 200);
    const state = await response.json() as State;
    assert.equal(state.runtime.running, true);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].destinations[0].url, secrets.HOOK);
    assert.deepEqual(state.configuredSecrets, ['HOOK']);
    assert.equal(state.config?.destinations[0].urlEnv, 'HOOK');
    assert.ok(!JSON.stringify(state).includes('PRIVATE-URL'));
    const previousToken = app.token;
    await app.server.close();
    const restarted = await startWebServer({ statePath: app.statePath, port: 0, logger, onApply: async config => { applied.push(config); } });
    try {
      assert.notEqual(new URL(restarted.url).hash, `#token=${previousToken}`);
      assert.equal(applied.length, 2);
      assert.equal((await fetch(`${new URL(restarted.url).origin}/api/state`, { headers: { 'X-Notifier-Token': previousToken } })).status, 401);
    } finally { await restarted.close(); }
  } finally { await app.cleanup(); }
});

test('a conflicting port fails before attempting to start monitoring', async () => {
  const app = await fixture();
  let applies = 0;
  try {
    await assert.rejects(startWebServer({
      statePath: app.statePath,
      port: Number(app.url.port),
      logger,
      initial: { config: input, secrets },
      onApply: async () => { applies += 1; },
    }), /port is available/);
    assert.equal(applies, 0);
  } finally { await app.cleanup(); }
});

test('invalid configuration is sanitized, requests are bounded, and stale saves do not apply', async () => {
  let count = 0;
  const app = await fixture({ initial: { config: input, secrets }, onApply: async () => { count += 1; } });
  try {
    const state = await app.getState();
    const invalid = await app.call('/api/config', { revision: state.revision, config: { ...input, 'LEAK-ME': true }, secrets: {} });
    assert.equal(invalid.status, 400);
    assert.ok(!(await invalid.text()).includes('LEAK-ME'));
    assert.equal((await app.call('/api/config', { revision: state.revision, config: { ...input, hostname: 'new' }, secrets: {} })).status, 200);
    const stale = await app.call('/api/config', { revision: state.revision, config: input, secrets: {} });
    assert.equal(stale.status, 409);
    assert.equal(count, 2);
    const oversized = await app.call('/api/config', { revision: state.revision, config: input, secrets: { HOOK: 'x'.repeat(1_048_576) } });
    assert.equal(oversized.status, 413);
    const malformed = await fetch(`${app.url.origin}/api/config`, { method: 'POST', headers: { 'X-Notifier-Token': app.token, 'Content-Type': 'application/json' }, body: 'secret malformed' });
    assert.equal(malformed.status, 400);
    assert.ok(!(await malformed.text()).includes('secret malformed'));
    const wrongType = await fetch(`${app.url.origin}/api/config`, { method: 'POST', headers: { 'X-Notifier-Token': app.token, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(wrongType.status, 415);
    assert.equal((await app.getState()).config?.hostname, 'new');
  } finally { await app.cleanup(); }
});

test('runtime failures preserve saved changes, sanitize errors, and a later save retries application', async () => {
  let fail = true;
  const logs: string[] = [];
  const app = await fixture({
    logger: (_level, message) => { logs.push(message); },
    onApply: async () => { if (fail) throw new Error('PRIVATE-RUNTIME-CREDENTIAL'); },
    getRuntimeStatus: () => ({ running: !fail, message: 'PRIVATE-STATUS-CREDENTIAL' }),
  });
  try {
    const before = await app.getState();
    const response = await app.call('/api/config', { revision: before.revision, config: input, secrets });
    assert.equal(response.status, 200);
    const saved = await response.json() as State;
    assert.equal(saved.runtime.running, false);
    assert.match(saved.message!, /saved.*could not start/);
    assert.ok(!(JSON.stringify(saved) + logs.join('')).includes('PRIVATE-RUNTIME-CREDENTIAL'));
    assert.ok(!JSON.stringify(before).includes('PRIVATE-STATUS-CREDENTIAL'));
    assert.equal(JSON.parse(await readFile(app.statePath, 'utf8')).secrets.HOOK, secrets.HOOK);
    fail = false;
    const retry = await app.call('/api/config', { revision: saved.revision, config: saved.config, secrets: {} });
    assert.equal((await retry.json() as State).runtime.running, true);
  } finally { await app.cleanup(); }
});

test('test notification reaches only the explicit saved channel, independent of workflow filters', async () => {
  const delivered: { path?: string; payload: Record<string, unknown>; auth?: string }[] = [];
  let fail = false;
  const receiver = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', chunk => parts.push(chunk));
    request.on('end', () => {
      delivered.push({ path: request.url, payload: JSON.parse(Buffer.concat(parts).toString('utf8')), auth: request.headers.authorization });
      response.writeHead(fail ? 500 : 204); response.end();
    });
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const config = {
    destinations: [
      { id: 'first', format: 'generic', urlEnv: 'FIRST', allowInsecureHttp: true, headersEnv: { Authorization: 'AUTH' } },
      { id: 'second', format: 'generic', urlEnv: 'SECOND', allowInsecureHttp: true },
      { id: 'disabled', format: 'generic', urlEnv: 'NONE', enabled: false },
    ],
    routes: [{ destinations: ['second'], events: ['cpu.high'], processes: ['worker'], namespaces: ['payments'], excludeNamespaces: ['*'], scope: 'process', severities: ['critical'] }],
  };
  const app = await fixture({ initial: { config, secrets: { FIRST: `${url}/first`, SECOND: `${url}/second`, AUTH: 'Bearer local-test' } } });
  try {
    assert.equal(delivered.length, 0);
    const response = await app.call('/api/test', { destination: 'first' });
    assert.equal(response.status, 200);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].path, '/first');
    assert.equal(delivered[0].auth, 'Bearer local-test');
    assert.equal(delivered[0].payload.type, 'notifier.test');
    for (const data of [{ destination: 'disabled' }, { destination: 'unknown' }, { destination: 'first', url: `${url}/unsaved` }]) {
      assert.equal((await app.call('/api/test', data)).status, 400);
    }
    assert.equal(delivered.length, 1);
    fail = true;
    assert.equal((await app.call('/api/test', { destination: 'first' })).status, 502);
    assert.equal(delivered.length, 2);
  } finally {
    await app.cleanup();
    await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
  }
});

test('saves and test operations serialize so tests see successfully saved destination credentials', async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const applying = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const app = await fixture({ onApply: async () => { started!(); await held; } });
  try {
    const before = await app.getState();
    const saving = app.call('/api/config', { revision: before.revision, config: input, secrets });
    await applying;
    let stateReturned = false;
    const reading = app.getState().then(state => { stateReturned = true; return state; });
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(stateReturned, false);
    release!();
    assert.equal((await saving).status, 200);
    assert.equal((await reading).runtime.running, true);
  } finally { release!(); await app.cleanup(); }
});

test('shutdown cancels a stalled webhook test and closes incomplete browser requests promptly', { timeout: 5_000 }, async () => {
  let received: (() => void) | undefined;
  const testStarted = new Promise<void>(resolve => { received = resolve; });
  const receiver = createServer(request => { request.resume(); received!(); });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  assert.ok(address && typeof address !== 'string');
  let applies = 0;
  const app = await fixture({
    initial: {
      config: {
        destinations: [{ id: 'slow', format: 'generic', urlEnv: 'SLOW', allowInsecureHttp: true }],
        routes: [{ destinations: ['slow'] }],
        delivery: { timeoutMs: 120_000 },
      },
      secrets: { SLOW: `http://127.0.0.1:${address.port}/slow` },
    },
    onApply: async () => { applies += 1; },
  });
  const partial = connect({ host: '127.0.0.1', port: Number(app.url.port) });
  partial.on('error', () => undefined);
  try {
    await new Promise<void>(resolve => partial.once('connect', resolve));
    partial.write(`POST /api/config HTTP/1.1\r\nHost: ${app.url.host}\r\nX-Notifier-Token: ${app.token}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
    const testing = app.call('/api/test', { destination: 'slow' }).catch(() => null);
    await testStarted;
    const start = Date.now();
    await app.server.close();
    assert.ok(Date.now() - start < 1_500, 'shutdown must not wait for the configured 120-second webhook timeout');
    await testing;
    await assert.rejects(app.call('/api/config', { revision: 'after-close', config: input, secrets }));
    assert.equal(applies, 1);
  } finally {
    partial.destroy();
    await app.cleanup();
    receiver.closeAllConnections();
    await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
  }
});

test('shutdown waits for an in-progress apply but prevents subsequent queued saves from applying', { timeout: 5_000 }, async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const applying = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let applies = 0;
  const app = await fixture({
    initial: { config: input, secrets },
    onApply: async () => {
      applies += 1;
      if (applies === 2) { started!(); await held; }
    },
  });
  try {
    const before = await app.getState();
    const data = { revision: before.revision, config: before.config, secrets: {} };
    const firstSave = app.call('/api/config', data).catch(() => null);
    await applying;
    const queuedSave = app.call('/api/config', data).catch(() => null);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    let closed = false;
    const closing = app.server.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(closed, false, 'an active apply must be allowed to complete');
    release!();
    await closing;
    await Promise.all([firstSave, queuedSave]);
    assert.equal(applies, 2, 'a queued save must not start another runtime after shutdown begins');
  } finally { release!(); await app.cleanup(); }
});
