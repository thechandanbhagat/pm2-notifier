import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultStatePath, parseUiEnabled, parseUiPort, startUiApplication } from '../src/application';
import { parseConfig } from '../src/config';
import type { startWebServer } from '../src/web-server';
import type { Config } from '../src/types';

const quietConfig = (hostname: string) => parseConfig({
  hostname, destinations: [{ id: 'off', format: 'generic', urlEnv: 'UNSET', enabled: false }],
  routes: [{ destinations: ['off'] }],
}, {});

test('UI module settings reject invalid ports and booleans and keep managed files outside package', () => {
  assert.equal(parseUiPort(), 3100);
  assert.equal(parseUiPort('8080'), 8080);
  assert.equal(parseUiPort(65535), 65535);
  for (const value of ['', '1e3', '3000.1', ' 3000 ', 0, -1, 65536, NaN, true, null]) assert.throws(() => parseUiPort(value), /UI port/);
  assert.equal(parseUiEnabled(), true);
  assert.equal(parseUiEnabled('false'), false);
  assert.equal(parseUiEnabled(false), false);
  assert.throws(() => parseUiEnabled('no'), /uiEnabled/);
  assert.equal(defaultStatePath({}, '/tmp/owner'), '/tmp/owner/.pm2/pm2-notifier/ui-settings.json');
  assert.equal(defaultStatePath({ PM2_HOME: '/tmp/custom' }, '/tmp/owner'), '/tmp/custom/pm2-notifier/ui-settings.json');
});

test('app applies workflows sequentially, recovers after startup failure, and shuts down once', async () => {
  let options: Parameters<typeof startWebServer>[0] | undefined;
  const events: string[] = [];
  const application = await startUiApplication({ statePath: '/tmp/unused-ui-state' }, () => {}, {
    startWebServer: async input => {
      options = input;
      return { url: 'http://127.0.0.1:3100/#token=test', close: async () => { events.push('close-ui'); } };
    },
    startRuntime: async config => {
      events.push(`start:${config.hostname}`);
      if (config.hostname === 'failure') throw new Error('SECRET');
      return { stop: async () => { events.push(`stop:${config.hostname}`); } };
    },
  });
  assert.equal(options?.getRuntimeStatus?.().running, false);
  await Promise.all([options!.onApply!(quietConfig('one')), options!.onApply!(quietConfig('two'))]);
  assert.deepEqual(events, ['start:one', 'stop:one', 'start:two']);
  assert.equal(options?.getRuntimeStatus?.().running, true);
  await assert.rejects(options!.onApply!(quietConfig('failure')), /Monitoring could not start/);
  assert.equal(options?.getRuntimeStatus?.().running, false);
  assert.ok(!options?.getRuntimeStatus?.().message?.includes('SECRET'));
  await options!.onApply!(quietConfig('recovered'));
  const stopping = application.stop();
  assert.equal(application.stop(), stopping);
  await stopping;
  assert.deepEqual(events.slice(-3), ['start:recovered', 'close-ui', 'stop:recovered']);
  await assert.rejects(options!.onApply!(quietConfig('after-close')), /shutting down/);
});

test('a drain failure is reported and replacement can still start after disconnect', async () => {
  let apply: ((config: Config) => Promise<void>) | undefined;
  const logs: string[] = [];
  const application = await startUiApplication({}, (_level, message) => { logs.push(message); }, {
    startWebServer: async input => {
      apply = input.onApply;
      await apply!(quietConfig('first'));
      return { url: 'http://127.0.0.1:3100/', close: async () => {} };
    },
    startRuntime: async config => ({ stop: async () => { if (config.hostname === 'first') throw new Error('SECRET'); } }),
  });
  await apply!(quietConfig('next'));
  assert.ok(logs.some(message => message.includes('queued alerts may be lost')));
  assert.ok(!logs.join().includes('SECRET'));
  await application.stop();
});

test('shutdown during the previous runtime drain prevents its replacement from starting', async () => {
  let apply: ((config: Config) => Promise<void>) | undefined;
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const drainStarted = new Promise<void>(resolve => { started = resolve; });
  const draining = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const application = await startUiApplication({}, () => {}, {
    startWebServer: async input => {
      apply = input.onApply;
      return { url: 'http://127.0.0.1:3100/', close: async () => { events.push('close-ui'); } };
    },
    startRuntime: async config => {
      events.push(`start:${config.hostname}`);
      return {
        stop: async () => {
          events.push(`stop:${config.hostname}`);
          started!();
          await draining;
        },
      };
    },
  });
  try {
    await apply!(quietConfig('first'));
    const replacement = assert.rejects(apply!(quietConfig('next')), /shutting down/);
    await drainStarted;
    const stopping = application.stop();
    release!();
    await Promise.all([replacement, stopping]);
    assert.deepEqual(events, ['start:first', 'stop:first', 'close-ui']);
  } finally {
    release!();
    await application.stop();
  }
});

test('UI listen failure cleans up a monitor started from saved settings', async () => {
  let stopped = false;
  await assert.rejects(startUiApplication({}, () => {}, {
    startWebServer: async input => {
      await input.onApply!(quietConfig('saved'));
      throw new Error('Port already in use');
    },
    startRuntime: async () => ({ stop: async () => { stopped = true; } }),
  }), /Port already in use/);
  assert.equal(stopped, true);
});

test('headless module uses managed settings without starting an HTTP listener', async () => {
  const events: string[] = [];
  const application = await startUiApplication({ uiEnabled: false }, () => {}, {
    loadManagedConfig: async () => quietConfig('saved'),
    startWebServer: async () => assert.fail('HTTP listener must be disabled'),
    startRuntime: async config => {
      events.push(config.hostname);
      return { stop: async () => { events.push('stopped'); } };
    },
  });
  await application.stop();
  assert.deepEqual(events, ['saved', 'stopped']);
  const idle = await startUiApplication({ uiEnabled: false }, () => {}, {
    loadManagedConfig: async () => null,
    startRuntime: async () => assert.fail('Empty state must not connect to PM2'),
  });
  await idle.stop();
});

test('manual configuration import loads env secrets without changing the process environment or source files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notifier-import-'));
  const configPath = join(directory, 'config.json');
  const envFile = join(directory, 'notifier.env');
  const variable = `NOTIFIER_IMPORT_TEST_${process.pid}`;
  const raw = { destinations: [{ id: 'main', format: 'generic', urlEnv: variable }], routes: [{ destinations: ['main'] }] };
  await writeFile(configPath, JSON.stringify(raw));
  await writeFile(envFile, `${variable}="https://example.test/private"\n`);
  try {
    const app = await startUiApplication({ configPath, envFile }, () => {}, {
      startWebServer: async options => {
        assert.deepEqual(options.initial?.config, raw);
        assert.equal(options.initial?.secrets[variable], 'https://example.test/private');
        return { url: 'http://127.0.0.1:3100/', close: async () => {} };
      },
    });
    assert.equal(process.env[variable], undefined);
    await app.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
