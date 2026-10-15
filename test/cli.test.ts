import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { runCli } from '../src/cli';

test('CLI validates without sending and test sends to loopback only; explicit destination bypasses routes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pm2-notifier-cli-test-'));
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(204).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const variable = `NOTIFIER_CLI_TEST_${process.pid}`;
  const file = join(directory, 'config.json');
  const envFile = join(directory, 'secrets.env');
  writeFileSync(envFile, `${variable}=http://127.0.0.1:${(server.address() as AddressInfo).port}/hook\n`);
  writeFileSync(file, JSON.stringify({ destinations: [{ id: 'local', format: 'generic', urlEnv: variable, allowInsecureHttp: true }], routes: [{ destinations: ['local'], events: ['cpu.*'] }] }));
  const logs: string[] = [];
  const logger = (_level: string, message: string) => { logs.push(message); };
  try {
    await runCli(['validate', '--config', file, '--env-file', envFile], logger);
    assert.equal(received.length, 0);
    await assert.rejects(runCli(['test', '--config', file], logger), /No enabled destination matches/);
    await runCli(['test', '--config', file, '--destination', 'local'], logger);
    assert.equal(received.length, 1);
    assert.equal((received[0] as { type: string }).type, 'notifier.test');
    writeFileSync(file, JSON.stringify({ destinations: [{ id: 'local', format: 'generic', urlEnv: variable, allowInsecureHttp: true }], routes: [{ destinations: ['local'] }] }));
    await runCli(['test', '--config', file], logger);
    assert.equal(received.length, 2);
    await assert.rejects(runCli(['test', '--config', file, '--destination', 'missing'], logger), /does not exist/);
    await assert.rejects(runCli(['validate', '--destination', 'local'], logger), /only supported/);
    await assert.rejects(runCli([], logger), /Usage/);
    await assert.rejects(runCli(['validate', '--config', join(directory, 'missing')], logger), /Cannot read/);
    assert.ok(logs.some(log => log.includes('accepted')));
  } finally {
    delete process.env[variable];
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true });
  }
});

test('CLI starts an empty setup UI without a config or env file and closes cleanly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pm2-notifier-ui-cli-'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const sigtermListeners = process.listenerCount('SIGTERM');
  let url: string | undefined;
  const application = await runCli(['ui', '--port', String(port), '--state-file', join(directory, 'settings.json')], (_level, _message, fields) => {
    if (typeof fields?.url === 'string') url = fields.url;
  });
  try {
    assert.ok(application);
    assert.ok(url);
    const location = new URL(url);
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    assert.ok(token);
    const response = await fetch(new URL('/api/state', location), { headers: { 'X-Notifier-Token': token } });
    assert.equal(response.status, 200);
    const state = await response.json() as { config: unknown; runtime: { running: boolean } };
    assert.equal(state.config, null);
    assert.equal(state.runtime.running, false);
    await assert.rejects(runCli(['ui', '--port', '0'], () => {}), /UI port/);
    await assert.rejects(runCli(['ui', '--destination', 'main'], () => {}), /only supported by test/);
    await assert.rejects(runCli(['validate', '--port', '3100'], () => {}), /only supported by ui/);
    await assert.rejects(runCli(['ui', '--env-file', '/missing'], () => {}), /requires --config/);
  } finally {
    await application?.stop();
    rmSync(directory, { recursive: true });
  }
  assert.equal(process.listenerCount('SIGTERM'), sigtermListeners);
});
