import { randomUUID } from 'node:crypto';
import type { Alert, Config, EventType, LifecycleEvent, ProcessSnapshot } from './types';

const SELF_NAME = '@thechandanbhagat/pm2-notifier';
const MAX_SAMPLE_GAP_MULTIPLIER = 2;
const RETIRED_RETENTION_MS = 300_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const ONLINE = 'online';

type TerminalType = 'process.stopped' | 'process.errored' | 'process.deleted';
interface CpuState {
  readonly lastSample: number;
  readonly highSince?: number;
  readonly recoverySince?: number;
  readonly alerted: boolean;
}
interface PendingState {
  readonly type: TerminalType;
  readonly since: number;
  readonly snapshot: ProcessSnapshot;
}
interface ProcessState {
  readonly snapshot: ProcessSnapshot;
  readonly onlineSnapshot?: ProcessSnapshot;
  readonly observedAt: number;
  readonly pending?: PendingState;
  readonly terminal?: TerminalType;
  readonly restartSnapshot?: ProcessSnapshot;
}
interface RetiredState {
  readonly name: string;
  readonly observedAt: number;
}

export function createMonitor(
  config: Pick<Config, 'hostname' | 'environment' | 'monitor'>,
  dependencies: { readonly createId?: () => string } = {},
) {
  const createId = dependencies.createId ?? randomUUID;
  const processStates = new Map<number, ProcessState>();
  const retired = new Map<number, RetiredState>();
  const cpuStates = new Map<string, CpuState>();
  const includePatterns = config.monitor.processes.include.map(glob);
  const excludePatterns = config.monitor.processes.exclude.map(glob);
  const maximumGap = config.monitor.pollIntervalMs * MAX_SAMPLE_GAP_MULTIPLIER;
  let lastSampleAt = -1;

  function eligible(process: ProcessSnapshot): boolean {
    return process.name !== SELF_NAME
      && (!process.isModule || config.monitor.processes.includeModules)
      && (includePatterns.length === 0 || includePatterns.some(pattern => pattern.test(process.name)))
      && !excludePatterns.some(pattern => pattern.test(process.name));
  }

  function alert(type: EventType, now: number, message: string,
    details: Alert['details'], process?: ProcessSnapshot): Alert {
    return {
      id: createId(), type,
      severity: type === 'cpu.high' || type === 'process.errored' ? 'critical'
        : type === 'process.stopped' || type === 'process.deleted' ? 'warning' : 'info',
      timestamp: new Date(now).toISOString(), hostname: config.hostname,
      ...(config.environment === undefined ? {} : { environment: config.environment }),
      ...(process ? { process: { name: process.name, pmId: process.pmId, ...(process.pid ? { pid: process.pid } : {}) } } : {}),
      message, details,
    };
  }

  function lifecycleAlert(type: EventType, process: ProcessSnapshot, now: number, previousExit?: ProcessSnapshot): Alert {
    const exitCode = previousExit?.exitCode ?? process.exitCode;
    const action = type.slice('process.'.length);
    return alert(type, now, `${process.name} ${action}`, {
      scope: 'process', status: process.status, restarts: process.restarts,
      exitCode: exitCode ?? null,
      reason: exitCode === undefined ? 'Unknown; PM2 did not provide an exit code.' : `PM2 reported exit code ${exitCode}.`,
    }, process);
  }

  function evaluateCpu(key: string, value: number | undefined, now: number, process?: ProcessSnapshot): Alert[] {
    const previous = cpuStates.get(key);
    const continuous = previous !== undefined && now - previous.lastSample <= maximumGap;
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      if (previous) cpuStates.set(key, { lastSample: now, alerted: previous.alerted });
      return [];
    }
    const { threshold, durationMs, recoveryThreshold, recoveryDurationMs } = config.monitor.cpu;
    const highSince = value >= threshold ? (continuous ? previous.highSince : undefined) ?? now : undefined;
    const recoverySince = value <= recoveryThreshold ? (continuous ? previous.recoverySince : undefined) ?? now : undefined;
    const alerted = previous?.alerted ?? false;
    const commonDetails = { scope: process ? 'process' : 'host', cpu: value, threshold, durationMs };
    const label = process ? process.name : config.hostname;
    if (!alerted && highSince !== undefined && now - highSince >= durationMs) {
      cpuStates.set(key, { lastSample: now, highSince, alerted: true });
      return [alert('cpu.high', now, `${label} CPU remained at or above ${threshold}% for ${durationMs / 1000} seconds`, commonDetails, process)];
    }
    if (alerted && recoverySince !== undefined && now - recoverySince >= recoveryDurationMs) {
      cpuStates.set(key, { lastSample: now, recoverySince, alerted: false });
      return [alert('cpu.recovered', now, `${label} CPU recovered to ${value}%`, {
        ...commonDetails, recoveryThreshold, recoveryDurationMs,
      }, process)];
    }
    cpuStates.set(key, { lastSample: now, highSince, recoverySince, alerted });
    return [];
  }

  function beginTerminal(previous: ProcessState, snapshot: ProcessSnapshot, type: TerminalType, now: number): ProcessState {
    cpuStates.delete(processKey(snapshot));
    return {
      ...previous, snapshot, observedAt: now,
      pending: previous.terminal === type ? undefined : {
        type,
        since: previous.pending?.type === type ? previous.pending.since : now,
        snapshot: { ...snapshot, exitCode: snapshot.exitCode ?? previous.pending?.snapshot.exitCode },
      },
    };
  }

  function observe(snapshot: ProcessSnapshot, now: number, sourceEvent?: string): Alert[] {
    const prior = processStates.get(snapshot.pmId);
    if (prior && (now < prior.observedAt || staleGeneration(snapshot, prior.snapshot))) return [];
    const previous = prior?.snapshot.name === snapshot.name ? prior : undefined;
    if (prior && !previous) cpuStates.delete(processKey(prior.snapshot));
    const retiredProcess = retired.get(snapshot.pmId);
    const terminalEvent = eventTerminal(sourceEvent);
    if (!previous && retiredProcess?.name === snapshot.name && terminalEvent) return [];
    retired.delete(snapshot.pmId);
    const baseline: ProcessState = previous ?? { snapshot, observedAt: now };
    const terminalType = terminalEvent === 'process.deleted' ? terminalEvent : statusTerminal(snapshot.status) ?? terminalEvent;
    if (terminalType) {
      if (!previous && sourceEvent === undefined) {
        processStates.set(snapshot.pmId, { snapshot, observedAt: now, terminal: terminalType });
      } else {
        processStates.set(snapshot.pmId, beginTerminal(baseline, snapshot, terminalType, now));
      }
      return [];
    }
    if (snapshot.status !== ONLINE) {
      cpuStates.delete(processKey(snapshot));
      processStates.set(snapshot.pmId, { ...baseline, snapshot, observedAt: now });
      return [];
    }
    const generationChanged = previous !== undefined && changedGeneration(snapshot, previous.onlineSnapshot ?? previous.snapshot);
    const resumedExit = previous?.pending !== undefined && previous.pending.type !== 'process.deleted'
      && (sourceEvent === 'online' || sourceEvent === 'start');
    const explicitRestart = sourceEvent === 'restart' || sourceEvent === 'reload';
    const restarted = generationChanged || resumedExit || explicitRestart;
    const duplicateRestart = previous?.restartSnapshot !== undefined
      && !changedGeneration(snapshot, previous.restartSnapshot) && !changedGeneration(previous.restartSnapshot, snapshot);
    const shouldRestart = restarted && !duplicateRestart;
    processStates.set(snapshot.pmId, {
      snapshot, onlineSnapshot: snapshot, observedAt: now,
      restartSnapshot: shouldRestart ? snapshot : previous?.restartSnapshot,
    });
    if (shouldRestart) cpuStates.delete(processKey(snapshot));
    if (!config.monitor.lifecycle.enabled) return [];
    if (shouldRestart) return [lifecycleAlert('process.restarted', snapshot, now, previous?.pending?.snapshot)];
    if (config.monitor.lifecycle.notifyOnStart && (!previous || previous.terminal || previous.pending?.type === 'process.deleted')) {
      return [lifecycleAlert('process.started', snapshot, now)];
    }
    return [];
  }

  function settle(now: number): Alert[] {
    const alerts: Alert[] = [];
    for (const [pmId, state] of processStates) {
      if (!state.pending || now - state.pending.since < config.monitor.lifecycle.settleMs) continue;
      if (config.monitor.lifecycle.enabled) alerts.push(lifecycleAlert(state.pending.type, state.pending.snapshot, now));
      if (state.pending.type === 'process.deleted') {
        processStates.delete(pmId);
        retired.set(pmId, { name: state.snapshot.name, observedAt: now });
      } else {
        processStates.set(pmId, { ...state, pending: undefined, terminal: state.pending.type });
      }
    }
    for (const [pmId, state] of retired) {
      if (now - state.observedAt > RETIRED_RETENTION_MS) retired.delete(pmId);
    }
    return alerts;
  }

  function sample(processes: readonly ProcessSnapshot[], hostCpu: number | undefined, now: number): Alert[] {
    validateTime(now);
    if (!Array.isArray(processes)) throw new TypeError('Process samples must be an array.');
    processes.forEach(validateProcess);
    if (now <= lastSampleAt) return [];
    lastSampleAt = now;
    const alerts: Alert[] = [];
    const present = new Set<number>();
    for (const process of processes) {
      if (!eligible(process)) continue;
      present.add(process.pmId);
      const previous = processStates.get(process.pmId);
      if (previous && (now < previous.observedAt || staleGeneration(process, previous.snapshot))) continue;
      alerts.push(...observe(process, now));
      if (config.monitor.cpu.enabled && config.monitor.cpu.scope !== 'host' && process.status === ONLINE) {
        alerts.push(...evaluateCpu(processKey(process), process.cpu, now, process));
      }
    }
    for (const [pmId, state] of processStates) {
      if (!present.has(pmId) && now >= state.observedAt) {
        processStates.set(pmId, beginTerminal(state, { ...state.snapshot, status: 'deleted' }, 'process.deleted', now));
      }
    }
    if (config.monitor.cpu.enabled && config.monitor.cpu.scope !== 'process') {
      alerts.push(...evaluateCpu('host', hostCpu, now));
    }
    alerts.push(...settle(now));
    return alerts;
  }

  function event(event: LifecycleEvent, now: number): Alert[] {
    validateTime(now);
    if (!event || typeof event.event !== 'string') throw new TypeError('A lifecycle event is required.');
    validateProcess(event.process);
    if (!eligible(event.process) || now < lastSampleAt) return [];
    const supported = ['exit', 'stop', 'delete', 'errored', 'restart overlimit', 'restart', 'reload', 'online', 'start'];
    if (!supported.includes(event.event)) return [];
    return [...observe(event.process, now, event.event), ...settle(now)];
  }

  function resetCpu(): void {
    cpuStates.clear();
  }

  return { sample, event, resetCpu };
}

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('').map(character => character === '*' ? '.*' : character === '?' ? '.' : character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}$`);
}

function processKey(process: ProcessSnapshot): string {
  return `process:${process.pmId}:${process.name}`;
}

function changedGeneration(current: ProcessSnapshot, previous: ProcessSnapshot): boolean {
  return current.restarts > previous.restarts
    || (current.pid !== undefined && previous.pid !== undefined && current.pid > 0 && previous.pid > 0 && current.pid !== previous.pid)
    || (current.uptime !== undefined && previous.uptime !== undefined && current.uptime > previous.uptime);
}

function staleGeneration(current: ProcessSnapshot, previous: ProcessSnapshot): boolean {
  return current.name === previous.name && current.uptime !== undefined && previous.uptime !== undefined && current.uptime < previous.uptime;
}

function statusTerminal(status: string): TerminalType | undefined {
  if (status === 'stopped') return 'process.stopped';
  if (status === 'errored') return 'process.errored';
  if (status === 'deleted') return 'process.deleted';
  return undefined;
}

function eventTerminal(event: string | undefined): TerminalType | undefined {
  if (event === 'stop' || event === 'exit') return 'process.stopped';
  if (event === 'delete') return 'process.deleted';
  if (event === 'errored' || event === 'restart overlimit') return 'process.errored';
  return undefined;
}

function validateTime(now: number): void {
  if (!Number.isFinite(now) || now < 0 || now > MAX_TIMESTAMP) throw new RangeError('Sample time must be a valid nonnegative timestamp.');
}

function validateProcess(process: ProcessSnapshot): void {
  if (!process || !Number.isSafeInteger(process.pmId) || process.pmId < 0 || typeof process.name !== 'string' || process.name.length === 0
    || typeof process.status !== 'string' || !Number.isSafeInteger(process.restarts) || process.restarts < 0) {
    throw new TypeError('Invalid PM2 process snapshot.');
  }
}
