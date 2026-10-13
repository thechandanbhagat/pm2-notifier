import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMonitor } from '../src/monitor';
import type { Config, MonitorConfig, ProcessSnapshot } from '../src/types';

const SECOND_MS = 1_000;
const POLL_MS = 5 * SECOND_MS;
const DURATION_MS = 60 * SECOND_MS;
const config: Pick<Config, 'hostname' | 'environment' | 'monitor'> = {
  hostname: 'server-a', environment: 'test', monitor: {
    pollIntervalMs: POLL_MS,
    processes: { include: ['*'], exclude: [], includeModules: false },
    cpu: { enabled: true, scope: 'both', threshold: 100, durationMs: DURATION_MS, recoveryThreshold: 80, recoveryDurationMs: 10 * SECOND_MS },
    lifecycle: { enabled: true, notifyOnStart: false, settleMs: POLL_MS },
  },
};
const process: ProcessSnapshot = { name: 'api', pmId: 1, pid: 101, status: 'online', cpu: 100, restarts: 0, uptime: 0, isModule: false };

function monitor(overrides: Partial<MonitorConfig> = {}) {
  return createMonitor({ ...config, monitor: { ...config.monitor, ...overrides } }, { createId: () => 'test-id' });
}

function samples(subject: ReturnType<typeof monitor>, start: number, end: number, cpu: number, hostCpu?: number) {
  return Array.from({ length: Math.floor((end - start) / POLL_MS) + 1 }, (_, index) => start + index * POLL_MS)
    .flatMap(now => subject.sample([{ ...process, cpu }], hostCpu, now));
}

test('CPU alerts at the exact duration boundary and once per incident for host and process', () => {
  const subject = monitor();
  assert.deepEqual(samples(subject, 0, DURATION_MS - POLL_MS, 100, 100), []);
  const alerts = subject.sample([process], 100, DURATION_MS);
  assert.deepEqual(alerts.map(alert => [alert.type, alert.details.scope]), [['cpu.high', 'process'], ['cpu.high', 'host']]);
  assert.equal(alerts[0].process?.name, 'api');
  assert.equal(alerts[1].process, undefined);
  assert.equal(alerts[0].timestamp, new Date(DURATION_MS).toISOString());
  assert.equal(alerts[0].id, 'test-id');
  assert.equal(alerts[0].hostname, 'server-a');
  assert.equal(alerts[0].environment, 'test');
  assert.deepEqual(samples(subject, DURATION_MS + POLL_MS, 2 * DURATION_MS, 100, 100), []);
});

test('CPU dips below threshold interrupt continuous saturation', () => {
  const subject = monitor();
  assert.deepEqual(samples(subject, 0, DURATION_MS - POLL_MS, 100), []);
  assert.deepEqual(subject.sample([{ ...process, cpu: 99.9 }], undefined, DURATION_MS), []);
  assert.deepEqual(samples(subject, DURATION_MS + POLL_MS, 2 * DURATION_MS, 100), []);
  assert.equal(subject.sample([process], undefined, 2 * DURATION_MS + POLL_MS)[0].type, 'cpu.high');
});

test('gaps longer than two poll intervals reset CPU continuity; exact boundary remains continuous', () => {
  const subject = monitor();
  samples(subject, 0, DURATION_MS - POLL_MS, 100);
  assert.deepEqual(subject.sample([process], undefined, DURATION_MS + POLL_MS + 1), []);
  assert.deepEqual(samples(subject, DURATION_MS + 2 * POLL_MS, 2 * DURATION_MS + POLL_MS, 100), []);
  assert.equal(subject.sample([process], undefined, 2 * DURATION_MS + 2 * POLL_MS)[0].type, 'cpu.high');
  const boundary = monitor();
  samples(boundary, 0, DURATION_MS - POLL_MS, 100);
  assert.equal(boundary.sample([process], undefined, DURATION_MS + POLL_MS)[0].type, 'cpu.high');
});

test('CPU recovery uses sustained hysteresis and permits a new incident', () => {
  const subject = monitor();
  samples(subject, 0, DURATION_MS, 100);
  assert.deepEqual(samples(subject, DURATION_MS + POLL_MS, DURATION_MS + 3 * POLL_MS, 90), []);
  assert.deepEqual(subject.sample([{ ...process, cpu: 80 }], undefined, DURATION_MS + 4 * POLL_MS), []);
  assert.deepEqual(subject.sample([{ ...process, cpu: 81 }], undefined, DURATION_MS + 5 * POLL_MS), []);
  assert.deepEqual(samples(subject, DURATION_MS + 6 * POLL_MS, DURATION_MS + 7 * POLL_MS, 80), []);
  assert.equal(subject.sample([{ ...process, cpu: 80 }], undefined, DURATION_MS + 8 * POLL_MS)[0].type, 'cpu.recovered');
  assert.equal(samples(subject, DURATION_MS + 9 * POLL_MS, 2 * DURATION_MS + 9 * POLL_MS, 100).at(-1)?.type, 'cpu.high');
});

test('invalid CPU readings interrupt continuity without clearing an active incident', () => {
  for (const cpu of [undefined, NaN, Infinity, -1]) {
    const subject = monitor();
    samples(subject, 0, DURATION_MS - POLL_MS, 100);
    assert.deepEqual(subject.sample([{ ...process, cpu }], undefined, DURATION_MS), []);
    assert.deepEqual(samples(subject, DURATION_MS + POLL_MS, 2 * DURATION_MS, 100), []);
    assert.equal(subject.sample([process], undefined, 2 * DURATION_MS + POLL_MS)[0].type, 'cpu.high');
    subject.sample([{ ...process, cpu }], undefined, 2 * DURATION_MS + 2 * POLL_MS);
    assert.deepEqual(samples(subject, 2 * DURATION_MS + 3 * POLL_MS, 3 * DURATION_MS + 3 * POLL_MS, 100), []);
  }
});

test('CPU reset discards continuity and allows rearming', () => {
  const subject = monitor();
  samples(subject, 0, DURATION_MS, 100);
  subject.resetCpu();
  assert.deepEqual(samples(subject, DURATION_MS + POLL_MS, 2 * DURATION_MS, 100), []);
  assert.equal(subject.sample([process], undefined, 2 * DURATION_MS + POLL_MS)[0].type, 'cpu.high');
});

test('scope and process filters honor wildcards, escapes, module exclusions and self exclusion', () => {
  const subject = monitor({
    processes: { include: ['api?', 'worker.*', 'pm2-notifier'], exclude: ['api2'], includeModules: true },
    cpu: { ...config.monitor.cpu, durationMs: 0, scope: 'process' },
  });
  const names = ['api1', 'api2', 'api12', 'worker.js', 'workerXjs', 'pm2-notifier'];
  const alerts = subject.sample(names.map((name, index) => ({ ...process, name, pmId: index, isModule: true })), 100, 0);
  assert.deepEqual(alerts.map(alert => alert.process?.name), ['api1', 'worker.js']);
  assert.deepEqual(monitor({ cpu: { ...config.monitor.cpu, durationMs: 0, scope: 'process' } }).sample([{ ...process, isModule: true }], 100, 0), []);
  assert.equal(monitor({ cpu: { ...config.monitor.cpu, durationMs: 0, scope: 'host' } }).sample([process], 100, 0)[0].details.scope, 'host');
});

test('baseline states remain quiet and notifyOnStart enables start alerts', () => {
  assert.deepEqual(monitor().sample([process, { ...process, pmId: 2, status: 'stopped' }], undefined, 0), []);
  const alerts = monitor({ lifecycle: { ...config.monitor.lifecycle, notifyOnStart: true } }).sample([process], undefined, 0);
  assert.equal(alerts[0].type, 'process.started');
  assert.equal(alerts[0].details.reason, 'Unknown; PM2 did not provide an exit code.');
});

test('restart counters, PID changes and uptime changes independently detect restarts', () => {
  for (const change of [{ restarts: 1 }, { pid: 102 }, { uptime: 1 }]) {
    const subject = monitor();
    subject.sample([process], undefined, 0);
    const next = { ...process, ...change };
    assert.equal(subject.sample([next], undefined, POLL_MS)[0].type, 'process.restarted');
    assert.deepEqual(subject.sample([next], undefined, 2 * POLL_MS), []);
    assert.deepEqual(subject.event({ event: 'restart', process: next }, 2 * POLL_MS + 1), []);
  }
});

test('flattened PM2 bus packets without a PID deduplicate restarts seen by polling', () => {
  const subject = monitor();
  subject.sample([process], undefined, 0);
  const next = { ...process, restarts: 1, uptime: 100, pid: 102 };
  assert.equal(subject.sample([next], undefined, POLL_MS)[0].type, 'process.restarted');
  assert.deepEqual(subject.event({ event: 'restart', process: { ...next, pid: undefined } }, POLL_MS + 1), []);
  assert.deepEqual(subject.sample([next], undefined, 2 * POLL_MS), []);
});

test('transient exit plus online bus events becomes one restart with available exit code', () => {
  const subject = monitor();
  subject.sample([process], undefined, 0);
  assert.deepEqual(subject.event({ event: 'exit', process: { ...process, exitCode: 137 } }, 1), []);
  const next = { ...process, pid: 102, uptime: 2, restarts: 1 };
  const alerts = subject.event({ event: 'online', process: next }, 2);
  assert.equal(alerts[0].type, 'process.restarted');
  assert.equal(alerts[0].details.exitCode, 137);
  assert.equal(alerts[0].details.reason, 'PM2 reported exit code 137.');
  assert.deepEqual(subject.event({ event: 'restart', process: next }, 3), []);
  assert.deepEqual(subject.sample([next], undefined, POLL_MS), []);
});

test('sampling launching before online does not lose evidence of a restart', () => {
  const subject = monitor();
  subject.sample([process], undefined, 0);
  const next = { ...process, pid: 102, restarts: 1, uptime: POLL_MS };
  assert.deepEqual(subject.sample([{ ...next, status: 'launching' }], undefined, POLL_MS), []);
  assert.equal(subject.sample([next], undefined, 2 * POLL_MS)[0].type, 'process.restarted');
});

test('PM2 restart-overlimit followed by exit preserves the errored classification', () => {
  const subject = monitor();
  subject.sample([process], undefined, 0);
  const failed = { ...process, status: 'errored', exitCode: 1 };
  assert.deepEqual(subject.event({ event: 'restart overlimit', process: failed }, 1), []);
  assert.deepEqual(subject.event({ event: 'exit', process: failed }, 2), []);
  assert.equal(subject.sample([failed], undefined, POLL_MS + 1)[0].type, 'process.errored');
  assert.deepEqual(subject.sample([failed], undefined, 2 * POLL_MS + 1), []);
});

test('stopped and errored statuses settle once, with status transitions preserved', () => {
  const subject = monitor();
  subject.sample([process], undefined, 0);
  const stopped = { ...process, status: 'stopped', cpu: 0, exitCode: 0 };
  assert.deepEqual(subject.sample([stopped], undefined, POLL_MS), []);
  assert.equal(subject.sample([stopped], undefined, 2 * POLL_MS)[0].type, 'process.stopped');
  assert.deepEqual(subject.sample([stopped], undefined, 3 * POLL_MS), []);
  const errored = { ...stopped, status: 'errored', exitCode: 1 };
  assert.deepEqual(subject.sample([errored], undefined, 4 * POLL_MS), []);
  const alerts = subject.sample([errored], undefined, 5 * POLL_MS);
  assert.equal(alerts[0].type, 'process.errored');
  assert.equal(alerts[0].severity, 'critical');
  assert.deepEqual(subject.sample([errored], undefined, 6 * POLL_MS), []);
});

test('missing processes settle as deleted and duplicate delete events are ignored', () => {
  const subject = monitor();
  subject.sample([process], undefined, 0);
  assert.deepEqual(subject.sample([], undefined, POLL_MS), []);
  assert.equal(subject.sample([], undefined, 2 * POLL_MS)[0].type, 'process.deleted');
  assert.deepEqual(subject.sample([], undefined, 3 * POLL_MS), []);
  assert.deepEqual(subject.event({ event: 'delete', process }, 3 * POLL_MS + 1), []);
  assert.deepEqual(subject.sample([process], undefined, 4 * POLL_MS), []);
});

test('short-lived processes captured only by exit events still generate settled alerts', () => {
  const subject = monitor();
  subject.sample([], undefined, 0);
  assert.deepEqual(subject.event({ event: 'exit', process: { ...process, status: 'stopped', exitCode: 1 } }, 1), []);
  assert.deepEqual(subject.sample([], undefined, POLL_MS), []);
  const alerts = subject.sample([], undefined, 2 * POLL_MS);
  assert.equal(alerts[0].type, 'process.deleted');
  assert.equal(alerts[0].details.exitCode, 1);
});

test('restarted and retired processes cannot inherit a previous CPU saturation window', () => {
  const subject = monitor();
  samples(subject, 0, DURATION_MS - POLL_MS, 100);
  const next = { ...process, restarts: 1, pid: 102, uptime: DURATION_MS };
  assert.deepEqual(subject.sample([next], undefined, DURATION_MS).map(alert => alert.type), ['process.restarted']);
  subject.sample([], undefined, DURATION_MS + POLL_MS);
  subject.sample([], undefined, DURATION_MS + 2 * POLL_MS);
  assert.deepEqual(subject.sample([next], undefined, DURATION_MS + 3 * POLL_MS), []);
});

test('out of order observations and older process generations cannot revert state', () => {
  const subject = monitor();
  subject.sample([process], undefined, 0);
  const next = { ...process, restarts: 1, uptime: 100, pid: 102 };
  subject.event({ event: 'online', process: next }, POLL_MS);
  assert.deepEqual(subject.sample([process], undefined, POLL_MS - 1), []);
  assert.deepEqual(subject.event({ event: 'exit', process }, POLL_MS + 1), []);
  assert.deepEqual(subject.sample([next], undefined, 2 * POLL_MS), []);
  assert.deepEqual(subject.sample([process], undefined, 2 * POLL_MS), []);
});

test('a delayed exit event followed by the unchanged online generation does not invent a restart', () => {
  const subject = monitor();
  subject.sample([process], undefined, 0);
  const next = { ...process, restarts: 1, uptime: 100, pid: 102 };
  assert.equal(subject.sample([next], undefined, POLL_MS)[0].type, 'process.restarted');
  assert.deepEqual(subject.event({ event: 'exit', process: next }, POLL_MS + 1), []);
  assert.deepEqual(subject.sample([next], undefined, 2 * POLL_MS), []);
  assert.deepEqual(subject.sample([next], undefined, 3 * POLL_MS), []);
});

test('disabled lifecycle and CPU monitors remain quiet', () => {
  const subject = monitor({ cpu: { ...config.monitor.cpu, enabled: false }, lifecycle: { ...config.monitor.lifecycle, enabled: false, notifyOnStart: true } });
  assert.deepEqual(samples(subject, 0, DURATION_MS, 100, 100), []);
  assert.deepEqual(subject.event({ event: 'restart', process }, DURATION_MS + 1), []);
  assert.deepEqual(subject.event({ event: 'delete', process }, DURATION_MS + 2), []);
  assert.deepEqual(subject.sample([], undefined, 2 * DURATION_MS), []);
});

test('empty and unknown events are safe; malformed boundaries fail loudly', () => {
  const subject = monitor();
  assert.deepEqual(subject.sample([], undefined, 0), []);
  assert.deepEqual(subject.event({ event: 'log', process }, 1), []);
  assert.throws(() => subject.sample(null as unknown as ProcessSnapshot[], undefined, 2), TypeError);
  assert.throws(() => subject.sample([null as unknown as ProcessSnapshot], undefined, 2), TypeError);
  assert.throws(() => subject.event(null as never, 2), TypeError);
  assert.throws(() => subject.sample([process], undefined, NaN), RangeError);
  assert.throws(() => subject.sample([process], undefined, Number.MAX_VALUE), RangeError);
  assert.throws(() => subject.sample([{ ...process, pmId: -1 }], undefined, 2), TypeError);
});
