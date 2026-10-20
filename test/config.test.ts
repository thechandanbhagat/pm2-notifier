import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, loadConfig } from '../src/config';

const input = { destinations: [{ id: 'ops', format: 'teams', urlEnv: 'HOOK' }], routes: [{ destinations: ['ops'] }] };
const env = { HOOK: 'https://example.com/private-hook' };
const MAX_ROUTE_PATTERNS = 100;
const MAX_ROUTE_PATTERN_LENGTH = 200;

test('configuration defaults and environment resolution are usable', () => {
  const config = parseConfig(input, env);
  assert.equal(config.monitor.cpu.durationMs, 60_000);
  assert.equal(config.monitor.cpu.scope, 'both');
  assert.equal(config.destinations[0].url, env.HOOK);
  assert.deepEqual(config.routes[0].processes, ['*']);
  assert.deepEqual(config.routes[0].namespaces, ['*']);
  assert.deepEqual(config.routes[0].excludeNamespaces, []);
  assert.equal(config.delivery.maxQueueSize, 500);
  assert.equal(config.delivery.batchIntervalMs, 30_000);
});

test('configuration rejects empty/null, unknown fields, missing routes, duplicate IDs and invalid thresholds', () => {
  for (const value of [null, {}, [], { ...input, mystery: true }, { ...input, routes: [] },
    { ...input, destinations: [...input.destinations, ...input.destinations] },
    { ...input, routes: [{ destinations: ['missing'] }] },
    { ...input, routes: [{ destinations: ['ops'], events: ['cpu.spike'] }] },
    { ...input, monitor: { cpu: { threshold: 80, recoveryThreshold: 80 } } },
    { ...input, monitor: { cpu: { threshold: 101 } } },
    { ...input, delivery: { maxAttempts: 11 } },
    ...[-1, null, 86_400_001].map(batchIntervalMs => ({ ...input, delivery: { batchIntervalMs } })),
    { ...input, monitor: { pollIntervalMs: 499 } },
    { ...input, delivery: { baseDelayMs: 2_000, maxDelayMs: 1_000 } },
  ]) assert.throws(() => parseConfig(value, env));
  assert.equal(parseConfig({ ...input, monitor: { cpu: { scope: 'process', threshold: 100_000 } } }, env).monitor.cpu.threshold, 100_000);
});

test('secrets are required only for enabled destinations and never included in validation errors', () => {
  assert.throws(() => parseConfig(input, {}), /HOOK/);
  assert.throws(() => parseConfig(input, { HOOK: '   ' }), /empty/);
  const bad = ['http://example.com/SECRET', 'https://user:SECRET@example.com', 'file:///SECRET', 'https://example.com/#SECRET'];
  for (const url of bad) {
    try { parseConfig(input, { HOOK: url }); assert.fail('accepted invalid URL'); }
    catch (error) { assert.ok(!String(error).includes('SECRET')); }
  }
  const disabled = { ...input, destinations: [{ ...input.destinations[0], enabled: false }] };
  assert.equal(parseConfig(disabled, {}).destinations[0].enabled, false);
});

test('generic templates, secure custom headers and explicitly permitted HTTP are supported', () => {
  const generic = { ...input, destinations: [{ ...input.destinations[0], format: 'generic', allowInsecureHttp: true, headersEnv: { Authorization: 'TOKEN' }, template: { cpu: '{{details.cpu}}' } }] };
  const config = parseConfig(generic, { HOOK: 'http://127.0.0.1:1234/hook', TOKEN: 'Bearer test' });
  assert.equal(config.destinations[0].headers.Authorization, 'Bearer test');
  for (const header of ['Host', 'Content-Type', 'Content-Length', 'bad\nname']) {
    assert.throws(() => parseConfig({ ...generic, destinations: [{ ...generic.destinations[0], headersEnv: { [header]: 'TOKEN' } }] }, { ...env, TOKEN: 'test' }));
  }
  assert.throws(() => parseConfig(generic, { ...env, TOKEN: 'secret\r\nInjected: true' }), /invalid header value/);
  assert.throws(() => parseConfig({ ...input, destinations: [{ ...input.destinations[0], template: null }] }, env), /generic/);
});

test('loadConfig reports missing, malformed and oversized files without revealing their contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pm2-notifier-config-test-'));
  try {
    const file = join(directory, 'config.json');
    assert.throws(() => loadConfig(file, env), /Cannot read/);
    writeFileSync(file, 'SECRET MALFORMED');
    assert.throws(() => loadConfig(file, env), /^Error: Notifier configuration is not valid JSON$/);
    writeFileSync(file, ' '.repeat(1_048_577));
    assert.throws(() => loadConfig(file, env), /exceeds/);
    writeFileSync(file, JSON.stringify(input));
    assert.equal(loadConfig(file, env).destinations.length, 1);
  } finally { rmSync(directory, { recursive: true }); }
});

test('destination count accepts the maximum and rejects overflow', () => {
  const destinations = Array.from({ length: 100 }, (_, index) => ({ id: `channel-${index}`, format: 'generic', urlEnv: 'UNSET', enabled: false }));
  const routes = [{ destinations: ['channel-0'] }];
  assert.equal(parseConfig({ destinations, routes }, {}).destinations.length, 100);
  assert.throws(() => parseConfig({ destinations: [...destinations, { ...destinations[0], id: 'overflow' }], routes }, {}), /Invalid configuration/);
});

test('namespace route patterns preserve exact and glob values, accepting maximum count and length', () => {
  const patterns = Array.from({ length: MAX_ROUTE_PATTERNS }, () => 'n'.repeat(MAX_ROUTE_PATTERN_LENGTH));
  const config = parseConfig({ ...input, routes: [{ destinations: ['ops'], namespaces: patterns, excludeNamespaces: patterns }] }, env);
  assert.deepEqual(config.routes[0].namespaces, patterns);
  assert.deepEqual(config.routes[0].excludeNamespaces, patterns);
  const values = ['payments', 'orders-*', 'preview-?', 'namespace.v1+[blue]'];
  const custom = parseConfig({ ...input, routes: [{ destinations: ['ops'], namespaces: values, excludeNamespaces: ['sandbox-*'] }] }, env);
  assert.deepEqual(custom.routes[0].namespaces, values);
  assert.deepEqual(custom.routes[0].excludeNamespaces, ['sandbox-*']);
  assert.deepEqual(parseConfig({ ...input, routes: [{ destinations: ['ops'], excludeNamespaces: [] }] }, env).routes[0].excludeNamespaces, []);
});

test('namespace route patterns reject null, empty patterns and count or length overflow', () => {
  for (const field of ['namespaces', 'excludeNamespaces']) {
    const invalid = [null, 'payments', [null], [''], ['n'.repeat(MAX_ROUTE_PATTERN_LENGTH + 1)], Array.from({ length: MAX_ROUTE_PATTERNS + 1 }, () => 'payments')];
    for (const value of invalid) {
      assert.throws(() => parseConfig({ ...input, routes: [{ destinations: ['ops'], [field]: value }] }, env), new RegExp(`routes\\.0\\.${field}`));
    }
  }
  assert.throws(() => parseConfig({ ...input, routes: [{ destinations: ['ops'], namespaces: [] }] }, env), /routes\.0\.namespaces/);
});
