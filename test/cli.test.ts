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
    writeFileSync(file, JSON.stringify({ destinations: [{ id: 'local', format: 'generic', urlEnv: variable, allowInsecureHttp: true }], routes: [{ destinations: ['local'], namespaces: ['payments'], excludeNamespaces: ['*'] }] }));
    await assert.rejects(runCli(['test', '--config', file], logger), /No enabled destination matches/);
    await runCli(['test', '--config', file, '--destination', 'local'], logger);
    assert.equal(received.length, 2);
    writeFileSync(file, JSON.stringify({ destinations: [{ id: 'local', format: 'generic', urlEnv: variable, allowInsecureHttp: true }], routes: [{ destinations: ['local'] }] }));
    await runCli(['test', '--config', file], logger);
    assert.equal(received.length, 3);
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
