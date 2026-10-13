export const EVENT_TYPES = ['cpu.high', 'cpu.recovered', 'process.started', 'process.restarted', 'process.stopped', 'process.errored', 'process.deleted', 'notifier.test'] as const;
export type EventType = typeof EVENT_TYPES[number];
export type Severity = 'info' | 'warning' | 'critical';
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface Alert {
  readonly id: string;
  readonly type: EventType;
  readonly severity: Severity;
  readonly timestamp: string;
  readonly hostname: string;
  readonly environment?: string;
  readonly process?: { readonly name: string; readonly pmId: number; readonly pid?: number };
  readonly message: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MonitorConfig {
  readonly pollIntervalMs: number;
  readonly processes: { readonly include: readonly string[]; readonly exclude: readonly string[]; readonly includeModules: boolean };
  readonly cpu: { readonly enabled: boolean; readonly scope: 'process' | 'host' | 'both'; readonly threshold: number; readonly durationMs: number; readonly recoveryThreshold: number; readonly recoveryDurationMs: number };
  readonly lifecycle: { readonly enabled: boolean; readonly notifyOnStart: boolean; readonly settleMs: number };
}

export interface Destination {
  readonly id: string;
  readonly format: 'teams' | 'slack' | 'discord' | 'generic';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly template?: JsonValue;
}

export interface Route {
  readonly destinations: readonly string[];
  readonly events: readonly string[];
  readonly processes: readonly string[];
  readonly excludeProcesses: readonly string[];
  readonly severities: readonly Severity[];
  readonly scope: 'all' | 'host' | 'process';
}

export interface DeliveryConfig {
  readonly batchIntervalMs: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxQueueSize: number;
}

export interface Config {
  readonly hostname: string;
  readonly environment?: string;
  readonly monitor: MonitorConfig;
  readonly delivery: DeliveryConfig;
  readonly destinations: readonly Destination[];
  readonly routes: readonly Route[];
}

export type Logger = (level: 'info' | 'warn' | 'error', message: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface ProcessSnapshot {
  readonly pmId: number;
  readonly name: string;
  readonly pid?: number;
  readonly status: string;
  readonly cpu?: number;
  readonly restarts: number;
  readonly uptime?: number;
  readonly exitCode?: number | string;
  readonly isModule: boolean;
}

export interface LifecycleEvent {
  readonly event: string;
  readonly process: ProcessSnapshot;
}
