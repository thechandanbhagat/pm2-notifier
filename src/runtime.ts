import pm2 = require('pm2');
import { cpus, type CpuInfo } from 'node:os';
import { createMonitor } from './monitor';
import { createDispatcher } from './delivery';
import { DEFAULT_PM2_NAMESPACE } from './types';
import type { Config, Logger, ProcessSnapshot } from './types';

const RPC_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const PERCENT_SCALE = 100;
const SELF_NAME = '@thechandanbhagat/pm2-notifier';
type RecordValue = Record<string, unknown>;
type BusListener = (packet: unknown) => void;
interface Bus {
  on(event: string, listener: BusListener): unknown;
  removeListener?(event: string, listener: BusListener): unknown;
  off?(event: string, listener: BusListener): unknown;
  close?(): void;
}
interface Pm2Client {
  connect(callback: (error?: Error | null) => void): void;
  list(callback: (error: Error | null, processes?: unknown[]) => void): void;
  launchBus(callback: (error: Error | null, bus?: Bus) => void): void;
  disconnect(callback: (error?: Error | null) => void): void;
}
interface RuntimeDependencies {
  readonly client?: Pm2Client;
  readonly readCpus?: () => CpuInfo[];
  readonly now?: () => number;
}

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normalizeProcess(input: unknown): ProcessSnapshot | undefined {
  const value = record(input);
  const env = Object.keys(record(value.pm2_env)).length ? record(value.pm2_env) : value;
  const pmId = finite(value.pm_id ?? env.pm_id);
  const name = value.name ?? env.name;
  const namespace = env.namespace === undefined ? DEFAULT_PM2_NAMESPACE : env.namespace;
  if (pmId === undefined || !Number.isSafeInteger(pmId) || typeof name !== 'string' || !name) return undefined;
  if (typeof namespace !== 'string' || namespace.trim().length === 0) return undefined;
  const restarts = env.restart_time === undefined ? 0 : finite(env.restart_time);
  if (restarts === undefined || !Number.isSafeInteger(restarts)) return undefined;
  const exitCode = env.exit_code;
  return {
    pmId, name, namespace, pid: finite(value.pid ?? env.pid),
    status: typeof env.status === 'string' ? env.status : 'unknown',
    cpu: finite(record(value.monit).cpu),
    restarts,
    uptime: finite(env.pm_uptime),
    exitCode: typeof exitCode === 'string' || (typeof exitCode === 'number' && Number.isFinite(exitCode)) ? exitCode : undefined,
    isModule: env.pmx_module === true || env.pmx_module === 'true' || name === SELF_NAME,
  };
}

export function calculateHostCpu(previous: readonly CpuInfo[], current: readonly CpuInfo[]): number | undefined {
  if (!previous.length || previous.length !== current.length) return undefined;
  const deltas = current.map((cpu, index) => {
    const old = previous[index].times;
    const values = Object.keys(cpu.times) as (keyof CpuInfo['times'])[];
    const differences = values.map(key => cpu.times[key] - old[key]);
    if (differences.some(value => !Number.isFinite(value) || value < 0)) return undefined;
    return { total: differences.reduce((sum, value) => sum + value, 0), idle: cpu.times.idle - old.idle };
  });
  if (deltas.some(delta => !delta)) return undefined;
  const total = deltas.reduce((sum, delta) => sum + delta!.total, 0);
  const idle = deltas.reduce((sum, delta) => sum + delta!.idle, 0);
  return total > 0 ? Math.max(0, Math.min(PERCENT_SCALE, (1 - idle / total) * PERCENT_SCALE)) : undefined;
}

function rpc<T>(invoke: (callback: (error: Error | null | undefined, result?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('PM2 request timed out')), RPC_TIMEOUT_MS);
    try {
      invoke((error, result) => {
        clearTimeout(timeout);
        if (error) reject(new Error('PM2 request failed'));
        else resolve(result as T);
      });
    } catch {
      clearTimeout(timeout);
      reject(new Error('PM2 request failed'));
    }
  });
}

export async function startRuntime(config: Config, logger: Logger, dependencies: RuntimeDependencies = {}): Promise<{ stop(): Promise<void> }> {
  const client: Pm2Client = dependencies.client ?? pm2;
  const readCpus = dependencies.readCpus ?? cpus;
  const now = dependencies.now ?? Date.now;
  const monitor = createMonitor(config);
  const dispatcher = createDispatcher(config, logger);
  let previousCpus = readCpus();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bus: Bus | undefined;
  let sampling: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let failedPolls = 0;

  const publish = (alerts: ReturnType<typeof monitor.sample>) => {
    for (const alert of alerts) {
      logger('info', 'Alert generated', { event: alert.type, alertId: alert.id, process: alert.process?.name });
      dispatcher.enqueue(alert);
    }
  };
  const onEvent = (packet: unknown) => {
    if (stopped) return;
    const value = record(packet);
    const snapshot = normalizeProcess(value.process);
    if (snapshot && typeof value.event === 'string') publish(monitor.event({ event: value.event, process: snapshot }, now()));
  };
  const onBusError = () => logger('error', 'PM2 event bus error; polling remains active');
  const sample = async () => {
    try {
      const processes = await rpc<unknown[]>(callback => client.list(callback));
      if (stopped) return;
      if (!Array.isArray(processes)) throw new Error('Invalid PM2 process list');
      const snapshots = processes.map(normalizeProcess);
      if (snapshots.some(snapshot => snapshot === undefined)) throw new Error('Invalid PM2 process entry');
      const currentCpus = readCpus();
      const hostCpu = calculateHostCpu(previousCpus, currentCpus);
      previousCpus = currentCpus;
      publish(monitor.sample(snapshots as ProcessSnapshot[], hostCpu, now()));
      if (failedPolls) logger('info', 'PM2 polling recovered', { failedPolls });
      failedPolls = 0;
    } catch {
      if (stopped) return;
      failedPolls += 1;
      monitor.resetCpu();
      previousCpus = [];
      logger('error', 'PM2 sampling failed; CPU observation window reset', { failedPolls });
    }
  };
  const tick = () => {
    sampling = sample().finally(() => {
      if (!stopped) timer = setTimeout(tick, config.monitor.pollIntervalMs);
    });
  };
  try {
    await rpc<void>(callback => client.connect(callback));
    bus = await rpc<Bus>(callback => client.launchBus(callback));
    if (!bus) throw new Error('PM2 event bus unavailable');
    await sample();
    bus.on('process:event', onEvent);
    bus.on('error', onBusError);
    timer = setTimeout(tick, config.monitor.pollIntervalMs);
  } catch {
    try { await rpc<void>(callback => client.disconnect(callback)); }
    catch { logger('error', 'PM2 disconnect failed during startup cleanup'); }
    try { bus?.close?.(); } catch { logger('error', 'PM2 event bus close failed during startup cleanup'); }
    await dispatcher.close();
    throw new Error('Cannot initialize PM2 monitor');
  }
  logger('info', 'Notifier monitoring started', { hostname: config.hostname, destinations: config.destinations.filter(d => d.enabled).length, pollIntervalMs: config.monitor.pollIntervalMs });
  return {
    stop() {
      if (stopping) return stopping;
      stopped = true;
      if (timer) clearTimeout(timer);
      stopping = (async () => {
        let cleanupFailed = false;
        // PM2's axon bus exposes off(event), while injected EventEmitters expose removeListener.
        const unsubscribe = bus?.removeListener ?? bus?.off;
        for (const [event, listener] of [['process:event', onEvent], ['error', onBusError]] as const) {
          try { unsubscribe?.call(bus, event, listener); }
          catch { cleanupFailed = true; logger('error', 'PM2 event bus listener cleanup failed'); }
        }
        // Let PM2 close its own bus first. Closing it early makes disconnect report an error
        // before its asynchronous RPC cleanup finishes, which can invalidate the next runtime.
        const disconnecting = rpc<void>(callback => client.disconnect(callback))
          .catch(() => { cleanupFailed = true; logger('error', 'PM2 disconnect failed'); })
          .finally(() => {
            try { bus?.close?.(); } catch { cleanupFailed = true; logger('error', 'PM2 event bus close failed'); }
          });
        let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([disconnecting, (async () => { await sampling; await dispatcher.close(); })()]).then(results => {
              const failure = results.find(result => result.status === 'rejected');
              if (failure?.status === 'rejected') throw failure.reason;
            }),
            new Promise<never>((_, reject) => { shutdownTimer = setTimeout(() => reject(new Error('Notifier shutdown timed out; queued alerts may be lost')), SHUTDOWN_TIMEOUT_MS); }),
          ]);
          if (cleanupFailed) throw new Error('PM2 resource cleanup failed');
        } finally {
          if (shutdownTimer) clearTimeout(shutdownTimer);
        }
      })();
      return stopping;
    },
  };
}
