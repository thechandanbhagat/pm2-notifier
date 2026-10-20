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
      disconnect: callback => { events.push('disconnect'); callback(); },
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
    launchBus: () => assert.fail('unexpected bus'), disconnect: callback => { disconnected = true; callback(); },
  } }), /^Error: Cannot initialize PM2 monitor$/);
  assert.equal(disconnected, true);
});

test('runtime shuts down PM2 axon buses that expose off instead of removeListener', async () => {
  const events: string[] = [];
  const listeners = new Map<string, (packet: unknown) => void>();
  const bus = {
    on: (event: string, listener: (packet: unknown) => void) => { listeners.set(event, listener); },
    off: (event: string) => { events.push(`off:${event}`); listeners.delete(event); },
    close: () => { events.push('close'); },
  };
  const config = parseConfig({ destinations: [{ id: 'off', format: 'generic', urlEnv: 'UNSET', enabled: false }], routes: [{ destinations: ['off'] }] }, {});
  const runtime = await startRuntime(config, () => {}, { client: {
    connect: callback => callback(), list: callback => callback(null, []), launchBus: callback => callback(null, bus),
    disconnect: callback => { events.push('disconnect'); callback(); },
  } });
  assert.equal(listeners.size, 2);
  await runtime.stop();
  await runtime.stop();
  assert.equal(listeners.size, 0);
  assert.deepEqual(events, ['off:process:event', 'off:error', 'disconnect', 'close']);
});

test('listener cleanup failures still close the bus and disconnect before rejecting shutdown', async () => {
  const events: string[] = [];
  const bus = {
    on: () => {},
    off: (event: string) => { events.push(`off:${event}`); throw new Error('SECRET'); },
    close: () => { events.push('close'); },
  };
  const config = parseConfig({ destinations: [{ id: 'off', format: 'generic', urlEnv: 'UNSET', enabled: false }], routes: [{ destinations: ['off'] }] }, {});
  const runtime = await startRuntime(config, (_level, message) => { events.push(message); }, { client: {
    connect: callback => callback(), list: callback => callback(null, []), launchBus: callback => callback(null, bus),
    disconnect: callback => { events.push('disconnect'); callback(); },
  } });
  const stopping = runtime.stop();
  assert.equal(stopping, runtime.stop());
  await assert.rejects(stopping, /^Error: PM2 resource cleanup failed$/);
  assert.ok(events.includes('off:process:event'));
  assert.ok(events.includes('off:error'));
  assert.deepEqual(events.slice(-2), ['disconnect', 'close']);
  assert.ok(!events.join().includes('SECRET'));
});

test('runtime shutdown waits for asynchronous PM2 disconnect before allowing a replacement', async () => {
  let finishDisconnect: (() => void) | undefined;
  let busClosed = false;
  const bus = Object.assign(new EventEmitter(), { close: () => { busClosed = true; } });
  const config = parseConfig({ destinations: [{ id: 'off', format: 'generic', urlEnv: 'UNSET', enabled: false }], routes: [{ destinations: ['off'] }] }, {});
  const runtime = await startRuntime(config, () => {}, { client: {
    connect: callback => callback(), list: callback => callback(null, []), launchBus: callback => callback(null, bus),
    disconnect: callback => { finishDisconnect = callback; },
  } });
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(busClosed, false);
  finishDisconnect!();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(busClosed, true);
});

test('a failed delivery still waits for PM2 disconnect before shutdown rejects', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 400 });
  let finishDisconnect: (() => void) | undefined;
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    let recordFailure: (() => void) | undefined;
    const deliveryFailed = new Promise<void>(resolve => { recordFailure = resolve; });
    const config = parseConfig({
      monitor: { lifecycle: { notifyOnStart: true } },
      destinations: [{ id: 'ops', format: 'generic', urlEnv: 'HOOK' }], routes: [{ destinations: ['ops'] }],
    }, { HOOK: 'https://example.test/fixture' });
    runtime = await startRuntime(config, (_level, message) => { if (message === 'Webhook delivery failed') recordFailure!(); }, { client: {
      connect: callback => callback(),
      list: callback => callback(null, [{ pm_id: 1, name: 'worker', pm2_env: { status: 'online', restart_time: 0 } }]),
      launchBus: callback => callback(null, new EventEmitter()),
      disconnect: callback => { finishDisconnect = callback; },
    } });
    await deliveryFailed;
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; return undefined; }, error => { stopped = true; return error; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    finishDisconnect!();
    assert.match(String(await stopping), /Webhook delivery failed/);
  } finally {
    finishDisconnect?.();
    await runtime?.stop().catch(() => {});
    globalThis.fetch = originalFetch;
  }
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
    list: () => assert.fail('unexpected sample'), launchBus: () => assert.fail('unexpected bus'), disconnect: callback => callback(),
  } }), /^Error: Cannot initialize PM2 monitor$/);
});
