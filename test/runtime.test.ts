import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { CpuInfo } from 'node:os';
import { normalizeProcess, calculateHostCpu, startRuntime } from '../src/runtime';
import { parseConfig } from '../src/config';
import { DEFAULT_PM2_NAMESPACE } from '../src/types';

const cpu = (user: number, idle: number): CpuInfo => ({ model: 'test', speed: 1, times: { user, idle, sys: 0, nice: 0, irq: 0 } });

test('PM2 list entries and flattened bus packets normalize without forwarding environment or logs', () => {
  const fields = { pm_id: 0, name: 'api', namespace: 'payments', status: 'online', restart_time: 2, pm_uptime: 100, exit_code: 0, env: { SECRET: 'value' }, log: 'SECRET' };
  const nested = normalizeProcess({ pid: 123, monit: { cpu: 100 }, pm2_env: fields });
  assert.equal(nested?.pmId, 0);
  assert.equal(nested?.cpu, 100);
  assert.equal(nested?.exitCode, 0);
  assert.equal(nested?.namespace, 'payments');
  assert.ok(!JSON.stringify(nested).includes('SECRET'));
  assert.equal(normalizeProcess(fields)?.restarts, 2);
  assert.equal(normalizeProcess(fields)?.namespace, 'payments');
  assert.equal(normalizeProcess({ ...fields, pmx_module: true })?.isModule, true);
  assert.equal(normalizeProcess({ ...fields, name: '@thechandanbhagat/pm2-notifier' })?.isModule, true);
});

test('PM2 normalization defaults only missing namespaces and preserves their literal identity', () => {
  const fields = { pm_id: 1, name: 'api' };
  const longNamespace = 'payments'.repeat(1_000);
  for (const namespace of [undefined, DEFAULT_PM2_NAMESPACE, ' payments ', longNamespace]) {
    const expected = namespace === undefined ? DEFAULT_PM2_NAMESPACE : namespace;
    assert.equal(normalizeProcess({ ...fields, namespace })?.namespace, expected);
    assert.equal(normalizeProcess({ pm2_env: { ...fields, namespace } })?.namespace, expected);
  }
  assert.equal(normalizeProcess({ ...fields, namespace: 'outer', pm2_env: { ...fields, namespace: 'inner' } })?.namespace, 'inner');
});

test('PM2 normalization rejects malformed namespaces on list and bus entries', () => {
  const fields = { pm_id: 1, name: 'api' };
  for (const namespace of [null, '', ' ', '\t\n', 0, false, [], {}]) {
    assert.equal(normalizeProcess({ ...fields, namespace }), undefined);
    assert.equal(normalizeProcess({ pm2_env: { ...fields, namespace } }), undefined);
  }
});

test('PM2 invalid process identity and metric boundaries are handled explicitly', () => {
  for (const input of [null, undefined, [], {}, { pm_id: -1, name: 'x' }, { pm_id: 0.5, name: 'x' }, { pm_id: 1, name: '' }, { pm_id: 1, name: 'api', restart_time: 0.5 }, { pm_id: 1, name: 'api', restart_time: -1 }]) assert.equal(normalizeProcess(input), undefined);
  const result = normalizeProcess({ pm_id: 1, name: 'api', monit: { cpu: Infinity }, exit_code: NaN });
  assert.equal(result?.cpu, undefined);
  assert.equal(result?.exitCode, undefined);
});

test('host CPU uses total capacity across cores and rejects unavailable/reset counters', () => {
  assert.equal(calculateHostCpu([cpu(0, 0), cpu(0, 0)], [cpu(100, 0), cpu(0, 100)]), 50);
  assert.equal(calculateHostCpu([cpu(0, 0)], [cpu(100, 0)]), 100);
  assert.equal(calculateHostCpu([cpu(0, 0)], [cpu(0, 100)]), 0);
  assert.equal(calculateHostCpu([], []), undefined);
  assert.equal(calculateHostCpu([cpu(0, 0)], []), undefined);
  assert.equal(calculateHostCpu([cpu(0, 0)], [cpu(0, 0)]), undefined);
  assert.equal(calculateHostCpu([cpu(100, 0)], [cpu(0, 100)]), undefined);
});

test('runtime connects, tolerates a failed sample, subscribes and releases PM2 resources on shutdown', async () => {
  const events: string[] = [];
  const bus = Object.assign(new EventEmitter(), { close: () => { events.push('close'); } });
  const config = parseConfig({ destinations: [{ id: 'off', format: 'generic', urlEnv: 'UNSET', enabled: false }], routes: [{ destinations: ['off'] }] }, {});
  const runtime = await startRuntime(config, (_level, message) => { events.push(message); }, {
    client: {
      connect: callback => { events.push('connect'); callback(); },
      list: callback => callback(new Error('SECRET')),
      launchBus: callback => callback(null, bus),
      disconnect: () => { events.push('disconnect'); },
    }, readCpus: () => [],
  });
  assert.equal(bus.listenerCount('process:event'), 1);
  bus.emit('process:event', null);
  bus.emit('error', new Error('SECRET'));
  await runtime.stop();
  await runtime.stop();
  assert.equal(bus.listenerCount('process:event'), 0);
  assert.equal(events.filter(event => event === 'disconnect').length, 1);
  assert.ok(events.some(event => event.includes('sampling failed')));
  assert.ok(!events.join().includes('SECRET'));
});

test('runtime connection failures reject with sanitized diagnostics and disconnect', async () => {
  let disconnected = false;
  const config = parseConfig({ destinations: [{ id: 'off', format: 'generic', urlEnv: 'UNSET', enabled: false }], routes: [{ destinations: ['off'] }] }, {});
  await assert.rejects(startRuntime(config, () => {}, { client: {
    connect: callback => callback(new Error('SECRET')), list: () => assert.fail('unexpected list'),
    launchBus: () => assert.fail('unexpected bus'), disconnect: () => { disconnected = true; },
  } }), /^Error: Cannot initialize PM2 monitor$/);
  assert.equal(disconnected, true);
});

test('runtime always attempts cleanup and repeated stop calls preserve the same failure', async () => {
  const events: string[] = [];
  const bus = Object.assign(new EventEmitter(), { close: () => { events.push('close'); throw new Error('SECRET'); } });
  const config = parseConfig({ destinations: [{ id: 'off', format: 'generic', urlEnv: 'UNSET', enabled: false }], routes: [{ destinations: ['off'] }] }, {});
  const runtime = await startRuntime(config, (_level, message) => { events.push(message); }, { client: {
    connect: callback => callback(), list: callback => callback(null, []), launchBus: callback => callback(null, bus),
    disconnect: () => { events.push('disconnect'); throw new Error('SECRET'); },
  } });
  const firstStop = runtime.stop();
  assert.equal(firstStop, runtime.stop());
  await assert.rejects(firstStop, /^Error: PM2 resource cleanup failed$/);
  assert.ok(events.includes('disconnect'));
  assert.ok(!events.join().includes('SECRET'));
});

test('bus startup failure occurs before sampling or delivery and sanitizes failed disconnect', async () => {
  const logs: string[] = [];
  const config = parseConfig({ destinations: [{ id: 'off', format: 'generic', urlEnv: 'UNSET', enabled: false }], routes: [{ destinations: ['off'] }] }, {});
  await assert.rejects(startRuntime(config, (_level, message) => { logs.push(message); }, { client: {
    connect: callback => callback(), list: () => assert.fail('must acquire bus before sampling'),
    launchBus: callback => callback(new Error('SECRET')),
    disconnect: () => { throw new Error('SECRET'); },
  } }), /^Error: Cannot initialize PM2 monitor$/);
  assert.ok(logs.some(message => message.includes('cleanup')));
  assert.ok(!logs.join().includes('SECRET'));
});

test('synchronous PM2 API failures reject immediately without exposing their message', async () => {
  const config = parseConfig({ destinations: [{ id: 'off', format: 'generic', urlEnv: 'UNSET', enabled: false }], routes: [{ destinations: ['off'] }] }, {});
  await assert.rejects(startRuntime(config, () => {}, { client: {
    connect: () => { throw new Error('SECRET'); },
    list: () => assert.fail('unexpected sample'), launchBus: () => assert.fail('unexpected bus'), disconnect: () => {},
  } }), /^Error: Cannot initialize PM2 monitor$/);
});
