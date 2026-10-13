import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config';
import { createDispatcher } from '../src/delivery';
import { createMonitor } from '../src/monitor';
import type { Alert, JsonValue, ProcessSnapshot } from '../src/types';

const SECOND_MS = 1_000;
const BATCH_INTERVAL_MS = 30 * SECOND_MS;
const SETTLE_MS = 3 * SECOND_MS;
const CYCLE_SPACING_MS = 7 * SECOND_MS;
const CYCLE_COUNT = 3;
const INITIAL_PID = 100;

test('repeated stop/start cycles batch once, deduplicate observations and retain the final stop with exit descriptions', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const config = parseConfig({
    hostname: 'batch-test',
    monitor: { cpu: { enabled: false }, lifecycle: { settleMs: SETTLE_MS } },
    destinations: [{ id: 'teams', format: 'teams', urlEnv: 'TEST_WEBHOOK' }],
    routes: [{ destinations: ['teams'] }],
  }, { TEST_WEBHOOK: 'https://example.invalid/teams' });
  const monitor = createMonitor(config);
  const alerts: Alert[] = [];
  const payloads: JsonValue[] = [];
  const dispatcher = createDispatcher(config, () => undefined, {
    fetch: async (_input, init) => {
      payloads.push(JSON.parse(init!.body as string) as JsonValue);
      return new Response(null, { status: 204 });
    },
  });
  const publish = (generated: Alert[]): void => {
    alerts.push(...generated);
    generated.forEach(dispatcher.enqueue);
  };
  let current: ProcessSnapshot = {
    name: 'service-test', pmId: 1, pid: INITIAL_PID, status: 'online', restarts: 0, uptime: 0, isModule: false,
  };
  publish(monitor.sample([current], undefined, 0));
  let elapsed = 0;
  for (let cycle = 0; cycle < CYCLE_COUNT; cycle += 1) {
    const stoppedAt = SECOND_MS + cycle * CYCLE_SPACING_MS;
    context.mock.timers.tick(stoppedAt - elapsed);
    publish(monitor.event({ event: 'stop', process: { ...current, status: 'stopped', exitCode: cycle } }, stoppedAt));
    const startedAt = stoppedAt + SECOND_MS;
    context.mock.timers.tick(SECOND_MS);
    current = { ...current, pid: INITIAL_PID + cycle + 1, uptime: startedAt, restarts: cycle + 1 };
    publish(monitor.event({ event: 'online', process: current }, startedAt));
    publish(monitor.event({ event: 'restart', process: current }, startedAt));
    publish(monitor.sample([current], undefined, startedAt));
    elapsed = startedAt;
  }
  const finalStopAt = SECOND_MS + CYCLE_COUNT * CYCLE_SPACING_MS;
  context.mock.timers.tick(finalStopAt - elapsed);
  current = { ...current, status: 'stopped', exitCode: 0 };
  publish(monitor.event({ event: 'stop', process: current }, finalStopAt));
  context.mock.timers.tick(SETTLE_MS);
  publish(monitor.sample([current], undefined, finalStopAt + SETTLE_MS));
  assert.deepEqual(alerts.map(alert => alert.type), [
    'process.restarted', 'process.restarted', 'process.restarted', 'process.stopped',
  ]);
  assert.deepEqual(alerts.map(alert => alert.details.exitCode), [0, 1, 2, 0]);
  assert.equal(payloads.length, 0);
  const deadline = 2 * SECOND_MS + BATCH_INTERVAL_MS;
  context.mock.timers.tick(deadline - (finalStopAt + SETTLE_MS) - 1);
  assert.equal(payloads.length, 0);
  context.mock.timers.tick(1);
  assert.equal(payloads.length, 1);
  await dispatcher.close();
  const object = payloads[0] as { attachments: Array<{ content: { body: Array<{ rows?: Array<{ cells: Array<{ items: Array<{ text: string }> }> }> }> } }> };
  const rows = object.attachments[0].content.body[2].rows!.slice(1).map(row => ({
    time: row.cells[0].items[0].text,
    process: row.cells[1].items.map(item => item.text),
    update: row.cells[2].items.map(item => item.text),
  }));
  assert.deepEqual(rows, [
    { time: '00:00:02', process: ['service-test', 'PM2 1'], update: ['Restarted', 'Exit 0 - clean exit'] },
    { time: '00:00:09', process: ['service-test', 'PM2 1'], update: ['Restarted', 'Exit 1 - usually indicates failure; meaning depends on the application'] },
    { time: '00:00:16', process: ['service-test', 'PM2 1'], update: ['Restarted', 'Exit 2 - usually indicates failure; meaning depends on the application'] },
    { time: '00:00:25', process: ['service-test', 'PM2 1'], update: ['Stopped', 'Exit 0 - clean exit'] },
  ]);
});
