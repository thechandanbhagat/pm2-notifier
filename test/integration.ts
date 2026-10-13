import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Alert, EventType } from '../src/types';

const COMMAND_TIMEOUT_MS = 120_000;
const ALERT_TIMEOUT_MS = 30_000;
const CHECK_INTERVAL_MS = 100;
const POLL_INTERVAL_MS = 500;
const DUPLICATE_CHECK_MS = 1_500;
const COMMAND_MAX_BUFFER_BYTES = 2_000_000;
const REGISTRY_HOST = '127.0.0.1';
const REGISTRY_PORT = 0;
const REGISTRY_TARBALL_PATH = '/module.tgz';
const HTTP_OK = 200;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const TEMP_PREFIX = 'pm2-notifier-smoke-';
const FIXTURE_NAME = 'notifier-smoke-fixture';
const BUNDLED_DEPENDENCY_NAMES = ['js-yaml', 'basic-ftp', 'ip-address'] as const;
const execute = promisify(execFile);
const pause = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));

async function main(): Promise<void> {
  if (process.platform === 'win32') throw new Error('Run this smoke test on Linux: PM2 uses shared named pipes on Windows.');
  const packageRoot = resolve(__dirname, '..');
  const packageMetadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    name: string; version: string; dependencies: Record<string, string>;
  };
  const packageName = packageMetadata.name;
  assert.ok(packageName.startsWith('@') && packageName.includes('/'), 'Smoke test requires a scoped npm package');
  const directory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const home = join(directory, 'pm2');
  const configPath = join(directory, 'notifier.json');
  const envPath = join(directory, 'notifier.env');
  const controlPath = join(directory, 'cpu-mode');
  const fixturePath = join(directory, 'fixture.cjs');
  const alerts: Alert[] = [];
  const errors: string[] = [];
  const registryRequests: string[] = [];
  let packedArchive: Buffer | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', error => errors.push(error.message));
    request.on('end', () => {
      try {
        alerts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Alert);
        response.writeHead(204).end();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Invalid webhook JSON');
        response.writeHead(400).end();
      }
    });
  });
  const registryServer = createServer((request, response) => {
    try {
      const requestPath = decodeURIComponent((request.url ?? '').split('?')[0]);
      registryRequests.push(`${request.method} ${requestPath}`);
      assert.equal(request.method, 'GET', `Unexpected registry request: ${request.method} ${requestPath}`);
      assert.ok(packedArchive, `Registry requested before the package was packed: ${request.method} ${requestPath}`);
      if (requestPath === REGISTRY_TARBALL_PATH) {
        response.writeHead(HTTP_OK, { 'Content-Type': 'application/octet-stream' }).end(packedArchive);
        return;
      }
      assert.equal(requestPath, `/${packageName}`, `Unexpected registry request: ${requestPath}`);
      const registryAddress = registryServer.address();
      assert.ok(registryAddress && typeof registryAddress !== 'string');
      response.writeHead(HTTP_OK, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        name: packageName,
        'dist-tags': { latest: packageMetadata.version },
        versions: {
          [packageMetadata.version]: {
            ...packageMetadata,
            bundleDependencies: Object.keys(packageMetadata.dependencies),
            dist: {
              tarball: `http://${REGISTRY_HOST}:${registryAddress.port}${REGISTRY_TARBALL_PATH}`,
              shasum: createHash('sha1').update(packedArchive).digest('hex'),
            },
          },
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Registry: ${message}`);
      response.writeHead(HTTP_INTERNAL_SERVER_ERROR).end(message);
    }
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  await new Promise<void>((done, reject) => { registryServer.once('error', reject); registryServer.listen(REGISTRY_PORT, REGISTRY_HOST, done); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const registryAddress = registryServer.address();
  assert.ok(registryAddress && typeof registryAddress !== 'string');
  const environment = {
    ...process.env,
    PM2_HOME: home,
    PM2_DISABLE_VERSION_CHECK: 'true',
    PM2_DISCRETE_MODE: 'true',
    NOTIFIER_CONFIG: '',
    NOTIFIER_ENV_FILE: '',
    npm_config_registry: `http://${REGISTRY_HOST}:${registryAddress.port}/`,
    npm_config_cache: join(directory, 'npm-cache'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
  const pm2 = async (...arguments_: string[]) => {
    const { stdout, stderr } = await execute(process.execPath, [join(packageRoot, 'node_modules/pm2/bin/pm2'), ...arguments_], {
      cwd: packageRoot, env: environment, timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    });
    return `${stdout}${stderr}`;
  };
  const waitFor = async (condition: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + ALERT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      assert.deepEqual(errors, [], 'Smoke fixture encountered an error');
      if (await condition()) return;
      await pause(CHECK_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for ${label}; received ${alerts.map(alert => alert.type).join(', ')}`);
  };
  const waitForAlert = async (type: EventType, name: string = FIXTURE_NAME) => {
    await waitFor(() => alerts.some(alert => alert.type === type && alert.process?.name === name), type);
    const matching = alerts.filter(alert => alert.type === type && alert.process?.name === name);
    assert.equal(matching.length, 1, `Expected one ${type} notification`);
    assert.equal(matching[0].process?.name, name);
    assert.equal(typeof matching[0].id, 'string');
    process.stdout.write(`PASS ${type} ${name}\n`);
  };
  let daemonStarted = false;
  let moduleLogPaths: readonly string[] = [];
  try {
    await writeFile(configPath, JSON.stringify({
      hostname: 'integration-smoke',
      monitor: {
        pollIntervalMs: POLL_INTERVAL_MS,
        processes: { include: [`${FIXTURE_NAME}*`] },
        cpu: { scope: 'process', threshold: 50, durationMs: 1_000, recoveryThreshold: 25, recoveryDurationMs: 1_000 },
        lifecycle: { settleMs: 750, notifyOnStart: false },
      },
      destinations: [{ id: 'loopback', format: 'generic', urlEnv: 'SMOKE_WEBHOOK_URL', allowInsecureHttp: true }],
      routes: [{ events: ['*'], destinations: ['loopback'] }],
    }));
    await writeFile(envPath, `SMOKE_WEBHOOK_URL=http://127.0.0.1:${address.port}/alerts\n`);
    await writeFile(controlPath, 'idle');
    await writeFile(fixturePath, [
      "const { readFileSync } = require('node:fs');",
      `const controlPath = ${JSON.stringify(controlPath)};`,
      'const intervalMs = 10;',
      'const busyDurationMs = 15;',
      'setInterval(() => {',
      "  if (readFileSync(controlPath, 'utf8') === 'crash') process.exit(42);",
      "  if (readFileSync(controlPath, 'utf8') === 'busy') {",
      '    const until = Date.now() + busyDurationMs;',
      '    while (Date.now() < until) Math.sqrt(Math.random());',
      '  }',
      '}, intervalMs);',
    ].join('\n'));
    daemonStarted = true;
    await pm2('start', fixturePath, '--name', FIXTURE_NAME);
    const { stdout: packOutput } = await execute('npm', ['pack', '--pack-destination', directory, '--ignore-scripts', '--json'], {
      cwd: packageRoot, env: environment, timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    });
    const packed = JSON.parse(packOutput) as { filename: string }[];
    assert.equal(packed.length, 1);
    packedArchive = await readFile(join(directory, packed[0].filename));
    await pm2('install', packageName);
    assert.deepEqual(errors, [], 'npm requested an unexpected registry resource');
    assert.ok(registryRequests.includes(`GET /${packageName}`), 'npm did not fetch package metadata');
    assert.ok(registryRequests.includes(`GET ${REGISTRY_TARBALL_PATH}`), 'npm did not fetch the packed archive');
    await pm2('set', `${packageName}:envFile`, envPath);
    await pm2('set', `${packageName}:configPath`, configPath);
    const installed = JSON.parse(await pm2('jlist')) as { name: string; pm2_env: { pm_exec_path: string; watch: boolean; status: string; pm_out_log_path: string; pm_err_log_path: string } }[];
    process.stdout.write(`${JSON.stringify(installed.map(entry => ({ name: entry.name, script: entry.pm2_env.pm_exec_path, watch: entry.pm2_env.watch, status: entry.pm2_env.status, log: entry.pm2_env.pm_out_log_path })))}\n`);
    const module = installed.find(entry => entry.name === packageName);
    assert.ok(module);
    assert.equal(module.pm2_env.pm_exec_path, join(home, 'modules', packageName, 'node_modules', packageName, 'dist', 'index.js'));
    assert.equal(module.pm2_env.watch, false);
    for (const dependencyName of BUNDLED_DEPENDENCY_NAMES) {
      const installedDependency = JSON.parse(await readFile(join(resolve(module.pm2_env.pm_exec_path, '..', '..'), 'node_modules', dependencyName, 'package.json'), 'utf8')) as { version: string };
      const expectedDependency = JSON.parse(await readFile(join(packageRoot, 'node_modules', dependencyName, 'package.json'), 'utf8')) as { version: string };
      assert.equal(installedDependency.version, expectedDependency.version, `Bundled ${dependencyName} version does not match the release dependency`);
      process.stdout.write(`PASS bundled ${dependencyName} ${installedDependency.version}\n`);
    }
    const logPath = module.pm2_env.pm_out_log_path;
    moduleLogPaths = [logPath, module.pm2_env.pm_err_log_path];
    await waitFor(async () => {
      try { return (await readFile(logPath, 'utf8')).includes('Notifier monitoring started'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    }, 'module startup');
    process.stdout.write(`PASS scoped PM2 registry install ${packageName}@${packageMetadata.version} and persisted configuration\n`);
    await writeFile(controlPath, 'busy');
    await waitForAlert('cpu.high');
    await writeFile(controlPath, 'idle');
    await waitForAlert('cpu.recovered');
    await pm2('restart', FIXTURE_NAME);
    await waitForAlert('process.restarted');
    await pause(DUPLICATE_CHECK_MS);
    assert.equal(alerts.filter(alert => alert.type === 'process.restarted').length, 1);
    await pm2('stop', FIXTURE_NAME);
    await waitForAlert('process.stopped');
    await pm2('delete', FIXTURE_NAME);
    await waitForAlert('process.deleted');
    assert.deepEqual(errors, []);
    assert.deepEqual(alerts.map(alert => alert.type), ['cpu.high', 'cpu.recovered', 'process.restarted', 'process.stopped', 'process.deleted']);
    const crashName = `${FIXTURE_NAME}-crash`;
    await pm2('start', fixturePath, '--name', crashName, '--no-autorestart');
    await pause(DUPLICATE_CHECK_MS);
    await writeFile(controlPath, 'crash');
    await waitForAlert('process.stopped', crashName);
    const crashAlert = alerts.find(alert => alert.type === 'process.stopped' && alert.process?.name === crashName);
    assert.equal(crashAlert?.details.exitCode, 42);
    assert.equal(crashAlert?.details.reason, 'PM2 reported exit code 42.');
    const restartStartedAt = Date.now();
    await pm2('kill');
    daemonStarted = false;
    daemonStarted = true;
    await pm2('ping');
    await waitFor(async () => {
      const restarted = JSON.parse(await pm2('jlist')) as { name: string; pm2_env: { status: string; pm_exec_path: string; pm_out_log_path: string } }[];
      const activeModule = restarted.find(entry => entry.name === packageName && entry.pm2_env.status === 'online');
      if (!activeModule) return false;
      assert.equal(activeModule.pm2_env.pm_exec_path, join(home, 'modules', packageName, 'node_modules', packageName, 'dist', 'index.js'));
      try {
        return (await readFile(activeModule.pm2_env.pm_out_log_path, 'utf8')).split('\n').some(line => {
          if (!line.includes('Notifier monitoring started')) return false;
          const entry = JSON.parse(line) as { timestamp: string; hostname: string };
          return Date.parse(entry.timestamp) >= restartStartedAt && entry.hostname === 'integration-smoke';
        });
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    }, 'registered module relaunch after daemon restart');
    process.stdout.write('PASS registered module relaunch after daemon restart\n');
    process.stdout.write(`${JSON.stringify({ platform: process.platform, node: process.version, events: alerts.map(alert => ({ type: alert.type, details: alert.details })) }, null, 2)}\n`);
  } catch (error) {
    for (const filename of moduleLogPaths) {
      try { process.stderr.write(await readFile(filename, 'utf8')); }
      catch (logError) { if ((logError as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`Cannot read smoke log: ${String(logError)}\n`); }
    }
    throw error;
  } finally {
    try { if (daemonStarted) await pm2('kill'); }
    finally {
      try {
        await Promise.all([server, registryServer].map(listener => new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()))));
      } finally {
        const resolvedDirectory = await realpath(directory);
        const resolvedTemporaryRoot = await realpath(tmpdir());
        assert.ok(resolvedDirectory.startsWith(`${resolvedTemporaryRoot}${sep}`) && basename(resolvedDirectory).startsWith(TEMP_PREFIX));
        await rm(resolvedDirectory, { recursive: true, force: true });
      }
    }
  }
}

void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
