import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { startRuntime } from './runtime';
import { loadManagedConfig, startWebServer } from './web-server';
import type { Config, Logger } from './types';

export interface Application {
  stop(): Promise<void>;
}

export interface UiOptions {
  readonly port?: number;
  readonly statePath?: string;
  readonly configPath?: string;
  readonly envFile?: string;
  readonly uiEnabled?: boolean;
}

interface ApplicationDependencies {
  readonly startRuntime?: typeof startRuntime;
  readonly startWebServer?: typeof startWebServer;
  readonly loadManagedConfig?: typeof loadManagedConfig;
}

export function defaultStatePath(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return resolve(environment.PM2_HOME || resolve(home, '.pm2'), 'pm2-notifier', 'ui-settings.json');
}

export function parseUiPort(value: unknown = 3100): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
    throw new Error('UI port must be an integer between 1 and 65535');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('UI port must be an integer between 1 and 65535');
  return port;
}

export function parseUiEnabled(value: unknown = true): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('uiEnabled must be true or false');
}

async function initialConfiguration(options: UiOptions) {
  if (!options.configPath) return undefined;
  let contents: Buffer;
  try { contents = await readFile(options.configPath); }
  catch { throw new Error('Cannot read notifier configuration file'); }
  if (contents.byteLength > 1_048_576) throw new Error('Configuration file exceeds 1 MiB');
  let config: unknown;
  try { config = JSON.parse(contents.toString('utf8')); }
  catch { throw new Error('Notifier configuration is not valid JSON'); }
  let fileSecrets: NodeJS.ProcessEnv = {};
  if (options.envFile) {
    try { fileSecrets = parseEnv(await readFile(options.envFile, 'utf8')); }
    catch { throw new Error('Cannot load notifier environment file'); }
  }
  return { config, secrets: { ...fileSecrets, ...process.env } };
}

/** Owns one PM2 connection. Replacements drain and disconnect before the next starts. */
export async function startUiApplication(options: UiOptions, logger: Logger, dependencies: ApplicationDependencies = {}): Promise<Application> {
  const start = dependencies.startRuntime ?? startRuntime;
  const serve = dependencies.startWebServer ?? startWebServer;
  const load = dependencies.loadManagedConfig ?? loadManagedConfig;
  const statePath = resolve(options.statePath || defaultStatePath());
  let runtime: Application | undefined;
  let web: Awaited<ReturnType<typeof startWebServer>> | undefined;
  let idle: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  let closing = false;
  let message = 'Add a channel and workflow to start monitoring.';
  let pending: Promise<void> = Promise.resolve();

  const apply = (config: Config): Promise<void> => {
    const operation = pending.then(async () => {
      if (closing) throw new Error('Notifier is shutting down');
      const previous = runtime;
      runtime = undefined;
      if (previous) {
        try { await previous.stop(); }
        catch { logger('warn', 'Previous monitor stopped with a delivery or cleanup error; queued alerts may be lost'); }
      }
      if (closing) throw new Error('Notifier is shutting down');
      try {
        runtime = await start(config, logger);
        message = 'Monitoring is active with the current settings.';
      } catch {
        message = 'Monitoring could not start. Check PM2 availability and save again to retry.';
        throw new Error(message);
      }
    });
    pending = operation.catch(() => {});
    return operation;
  };

  try {
    if (options.uiEnabled === false) {
      if (options.configPath) throw new Error('Importing configuration requires the UI to be enabled');
      const config = await load(statePath);
      if (config) await apply(config);
      else {
        logger('warn', 'Notifier is idle: enable the UI to create a workflow, or set configPath');
        idle = setInterval(() => {}, 60_000);
      }
    } else {
      web = await serve({
        port: options.port ?? 3100, statePath, logger,
        initial: await initialConfiguration(options), onApply: apply,
        getRuntimeStatus: () => ({ running: Boolean(runtime), message }),
      });
      logger('info', 'Notifier setup UI ready. Open this private link in your browser.', { url: web.url });
    }
  } catch (error) {
    if (runtime) await runtime.stop().catch(() => {});
    throw error;
  }

  return {
    stop() {
      if (stopping) return stopping;
      closing = true;
      if (idle) clearInterval(idle);
      stopping = (async () => {
        let failed = false;
        try { await web?.close(); } catch { failed = true; }
        await pending;
        try { await runtime?.stop(); } catch { failed = true; }
        runtime = undefined;
        if (failed) throw new Error('Notifier shutdown failed; undelivered alerts may be lost');
      })();
      return stopping;
    },
  };
}

/** Signal listeners are removed on stop so embedded CLI callers can clean up too. */
export function withShutdownHandlers(application: Application, logger: Logger, exitAfterSignal = false): Application {
  let stopping: Promise<void> | undefined;
  const handle = () => {
    void stop().then(() => { if (exitAfterSignal) process.exit(0); }).catch(() => {
      process.exitCode = 1;
      if (exitAfterSignal) process.exit(1);
    });
  };
  const onMessage = (message: unknown) => { if (message === 'shutdown') handle(); };
  const stop = () => {
    if (stopping) return stopping;
    process.removeListener('SIGINT', handle);
    process.removeListener('SIGTERM', handle);
    process.removeListener('message', onMessage);
    stopping = application.stop().catch(() => {
      logger('error', 'Notifier shutdown failed; undelivered alerts may be lost');
      throw new Error('Notifier shutdown failed');
    });
    return stopping;
  };
  process.once('SIGINT', handle);
  process.once('SIGTERM', handle);
  process.on('message', onMessage);
  return { stop };
}
