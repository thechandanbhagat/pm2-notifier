import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { z } from 'zod';
import { EVENT_TYPES, type Config, type JsonValue } from './types';

const MAX_CONFIG_BYTES = 1_048_576;
const MAX_PATTERN_LENGTH = 200;
const MAX_DESTINATIONS = 100;
const MAX_ROUTES = 500;
const MAX_DURATION_MS = 86_400_000;
const pattern = z.string().min(1).max(MAX_PATTERN_LENGTH);
const patterns = z.array(pattern).max(MAX_DESTINATIONS);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const milliseconds = z.number().int().min(1).max(MAX_DURATION_MS);
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json),
]));
const destinationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  format: z.enum(['teams', 'slack', 'discord', 'generic']),
  urlEnv: envName,
  headersEnv: z.record(z.string(), envName).default({}),
  enabled: z.boolean().default(true),
  allowInsecureHttp: z.boolean().default(false),
  template: json.optional(),
}).strict();
const schema = z.object({
  hostname: z.string().min(1).max(200).default(hostname),
  environment: z.string().min(1).max(200).optional(),
  monitor: z.object({
    pollIntervalMs: z.number().int().min(500).max(60_000).default(5_000),
    processes: z.object({
      include: patterns.min(1).default(['*']), exclude: patterns.default([]), includeModules: z.boolean().default(false),
    }).strict().prefault({}),
    cpu: z.object({
      enabled: z.boolean().default(true), scope: z.enum(['process', 'host', 'both']).default('both'),
      threshold: z.number().min(1).max(100_000).default(95),
      durationMs: milliseconds.default(60_000),
      recoveryThreshold: z.number().min(0).max(100_000).default(80),
      recoveryDurationMs: milliseconds.default(15_000),
    }).strict().prefault({}),
    lifecycle: z.object({
      enabled: z.boolean().default(true), notifyOnStart: z.boolean().default(false),
      settleMs: z.number().int().min(0).max(60_000).default(3_000),
    }).strict().prefault({}),
  }).strict().prefault({}),
  delivery: z.object({
    batchIntervalMs: z.number().int().min(0).max(MAX_DURATION_MS).default(30_000),
    timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    maxAttempts: z.number().int().min(1).max(10).default(4),
    baseDelayMs: milliseconds.default(1_000),
    maxDelayMs: milliseconds.default(30_000),
    maxQueueSize: z.number().int().min(1).max(10_000).default(500),
  }).strict().prefault({}),
  destinations: z.array(destinationSchema).min(1).max(MAX_DESTINATIONS),
  routes: z.array(z.object({
    destinations: z.array(z.string().min(1)).min(1).max(MAX_DESTINATIONS),
    events: patterns.min(1).default(['*']), processes: patterns.min(1).default(['*']),
    excludeProcesses: patterns.default([]),
    severities: z.array(z.enum(['info', 'warning', 'critical'])).min(1).default(['info', 'warning', 'critical']),
    scope: z.enum(['all', 'host', 'process']).default('all'),
  }).strict()).min(1).max(MAX_ROUTES),
}).strict();

function requireEnv(name: string, environment: NodeJS.ProcessEnv): string {
  const value = environment[name];
  if (!value?.trim()) throw new Error(`Required environment variable ${name} is missing or empty`);
  return value;
}

export type RawConfig = z.infer<typeof schema>;

export function parseRawConfig(input: unknown): RawConfig {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`);
    throw new Error(`Invalid configuration: ${issues.join('; ')}`);
  }
  return parsed.data;
}

export function parseConfig(input: unknown, environment: NodeJS.ProcessEnv = process.env): Config {
  const config = parseRawConfig(input);
  const ids = new Set(config.destinations.map(destination => destination.id));
  if (ids.size !== config.destinations.length) throw new Error('Destination IDs must be unique');
  const { cpu } = config.monitor;
  if (cpu.recoveryThreshold >= cpu.threshold) throw new Error('monitor.cpu.recoveryThreshold must be less than threshold');
  if (cpu.scope !== 'process' && cpu.threshold > 100) throw new Error('Host CPU threshold cannot exceed 100');
  if (config.delivery.baseDelayMs > config.delivery.maxDelayMs) throw new Error('delivery.baseDelayMs must not exceed maxDelayMs');
  const supportedPatterns = new Set<string>([...EVENT_TYPES, '*', 'cpu.*', 'process.*', 'notifier.*']);
  for (const route of config.routes) {
    if (route.destinations.some(id => !ids.has(id))) throw new Error('Route references an unknown destination ID');
    if (route.events.some(event => !supportedPatterns.has(event))) throw new Error('Route contains an unsupported event type or pattern');
  }
  const destinations = config.destinations.map(destination => {
    if (destination.template !== undefined && destination.format !== 'generic') throw new Error(`Destination ${destination.id}: template requires generic format`);
    if (!destination.enabled) return { ...destination, url: '', headers: {} };
    const rawUrl = requireEnv(destination.urlEnv, environment);
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new Error(`Destination ${destination.id}: invalid webhook URL`); }
    const validProtocol = url.protocol === 'https:' || (destination.allowInsecureHttp && url.protocol === 'http:');
    if (!validProtocol || url.username || url.password || url.hash) throw new Error(`Destination ${destination.id}: use HTTPS without URL credentials or fragment; HTTP requires allowInsecureHttp`);
    const headers = Object.fromEntries(Object.entries(destination.headersEnv).map(([name, variable]) => {
      const forbidden = /^(host|content-length|content-type|connection|transfer-encoding|upgrade|proxy-.*)$/i;
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || forbidden.test(name)) throw new Error(`Destination ${destination.id}: unsupported header name`);
      const value = requireEnv(variable, environment);
      if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new Error(`Destination ${destination.id}: invalid header value`);
      return [name, value];
    }));
    return { id: destination.id, format: destination.format, enabled: destination.enabled, template: destination.template, url: url.toString(), headers };
  });
  return { ...config, destinations };
}

export function loadConfig(path: string, environment: NodeJS.ProcessEnv = process.env): Config {
  let contents: Buffer;
  try { contents = readFileSync(path); } catch { throw new Error('Cannot read notifier configuration file'); }
  if (contents.byteLength > MAX_CONFIG_BYTES) throw new Error('Configuration file exceeds 1 MiB');
  let input: unknown;
  try { input = JSON.parse(contents.toString('utf8')); } catch { throw new Error('Notifier configuration is not valid JSON'); }
  return parseConfig(input, environment);
}
