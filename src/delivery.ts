import { DEFAULT_PM2_NAMESPACE, type Alert, type Config, type DeliveryConfig, type Destination, type JsonValue, type Logger, type Route } from './types';
import { LOGO_DATA_URI } from './branding';

const SLACK_TEXT_LIMIT = 2_900;
const DISCORD_TEXT_LIMIT = 4_000;
const TITLE_LIMIT = 200;
const TEAMS_BATCH_LIMIT = 20;
const TEAMS_PAYLOAD_LIMIT_BYTES = 28_000;
const TEAMS_MESSAGE_LIMIT = 350;
const REPOSITORY_URL = 'https://github.com/thechandanbhagat/pm2-notifier';
const LOGO_WIDTH = '32px';
const LOGO_HEIGHT = '32px';
const TIMELINE_TIME_WIDTH = '72px';
const TIMELINE_PROCESS_WEIGHT = 2;
const TIMELINE_UPDATE_WEIGHT = 3;
const CARD_TIME_ZONE = 'UTC';
const cardDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: CARD_TIME_ZONE });
const cardTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: CARD_TIME_ZONE });
const EVENT_LABELS: Readonly<Record<Alert['type'], string>> = {
  'cpu.high': 'High CPU', 'cpu.recovered': 'CPU recovered',
  'process.started': 'Started', 'process.restarted': 'Restarted',
  'process.stopped': 'Stopped', 'process.errored': 'Errored',
  'process.deleted': 'Deleted', 'notifier.test': 'Test received',
};
const MILLISECONDS_PER_SECOND = 1_000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;

const truncate = (value: string, limit: number): string => value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
const jsonCopy = (value: unknown): JsonValue => value === undefined ? null : JSON.parse(JSON.stringify(value)) as JsonValue;

function lookup(alert: Alert, path: string): JsonValue {
  const result = path.split('.').reduce<unknown>((value, key) => {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, alert);
  return jsonCopy(result);
}

function renderTemplate(template: JsonValue, alert: Alert): JsonValue {
  if (typeof template === 'string') {
    const whole = WHOLE_PLACEHOLDER.exec(template);
    if (whole) return lookup(alert, whole[1]);
    return template.replace(PLACEHOLDER, (_match: string, path: string) => {
      const value = lookup(alert, path);
      return value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    });
  }
  if (Array.isArray(template)) return template.map(value => renderTemplate(value, alert));
  if (template !== null && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, renderTemplate(value, alert)]));
  }
  return template;
}

function facts(alert: Alert): ReadonlyArray<readonly [string, string]> {
  return [
    ['Server', alert.hostname],
    ['Time', alert.timestamp],
    ['Severity', alert.severity],
    ...(alert.environment ? [['Environment', alert.environment] as const] : []),
    ...(alert.process ? [['Process', `${alert.process.name} (PM2 ${alert.process.pmId})`] as const] : []),
    ...Object.entries(alert.details).map(([key, value]) => [key, value === null ? 'unknown' : String(value)] as const),
  ];
}

const summary = (alert: Alert): string => [alert.type, alert.message, ...facts(alert).map(([key, value]) => `${key}: ${value}`)].join('\n');
const slackText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '@\u200b');

export function formatPayload(destination: Destination, alert: Alert): JsonValue {
  switch (destination.format) {
    case 'generic':
      return destination.template === undefined ? jsonCopy(alert) : renderTemplate(destination.template, alert);
    case 'slack': {
      const text = truncate(slackText(summary(alert)), SLACK_TEXT_LIMIT);
      return { text, blocks: [{ type: 'section', text: { type: 'plain_text', text } }], mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false };
    }
    case 'discord':
      return {
        allowed_mentions: { parse: [] },
        embeds: [{ title: truncate(`PM2: ${alert.type}`, TITLE_LIMIT), description: truncate(summary(alert), DISCORD_TEXT_LIMIT) }],
      };
    case 'teams':
      return formatTeamsBatch([alert]);
  }
}

function exitDescription(alert: Alert): string | undefined {
  if (!Object.hasOwn(alert.details, 'exitCode')) return undefined;
  const code = alert.details.exitCode;
  if (code === null || code === undefined || code === '') return 'Exit unknown - PM2 did not provide a code';
  if (code === 0 || code === '0') return 'Exit 0 - clean exit';
  return `Exit ${code} - usually indicates failure; meaning depends on the application`;
}

function timelineRow(alert: Alert): JsonValue {
  const detail = [typeof alert.details.cpu === 'number' ? `${alert.details.cpu}%` : undefined, exitDescription(alert)]
    .filter(Boolean).join(' / ');
  return {
    type: 'TableRow',
    cells: [
      { type: 'TableCell', verticalContentAlignment: 'Top', items: [
        { type: 'TextBlock', text: cardTime.format(new Date(alert.timestamp)), size: 'Small', fontType: 'Monospace', horizontalAlignment: 'Left', isSubtle: true, wrap: false },
      ] },
      { type: 'TableCell', verticalContentAlignment: 'Top', items: [
        { type: 'TextBlock', text: truncate(alert.process?.name ?? alert.hostname, TITLE_LIMIT), weight: 'Bolder', size: 'Small', wrap: true },
        ...(alert.process ? [{ type: 'TextBlock', text: `PM2 ${alert.process.pmId}`, size: 'Small', isSubtle: true, spacing: 'None', wrap: true }] : []),
      ] },
      { type: 'TableCell', verticalContentAlignment: 'Top', items: [
        { type: 'TextBlock', text: EVENT_LABELS[alert.type], weight: 'Bolder', size: 'Small', wrap: true,
          color: alert.severity === 'critical' ? 'Attention' : alert.severity === 'warning' ? 'Warning' : 'Default' },
        ...(detail ? [{ type: 'TextBlock', text: truncate(detail, TEAMS_MESSAGE_LIMIT), size: 'Small', isSubtle: true, spacing: 'None', wrap: true }] : []),
      ] },
    ],
  };
}

function formatTeamsBatch(alerts: readonly Alert[]): JsonValue {
  const first = alerts[0];
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.5',
        body: [
          { type: 'ColumnSet', columns: [
            { type: 'Column', width: 'auto', items: [
              { type: 'Image', url: LOGO_DATA_URI, altText: 'PM2 notifier logo', width: LOGO_WIDTH, height: LOGO_HEIGHT, selectAction: { type: 'Action.OpenUrl', url: REPOSITORY_URL } },
            ] },
            { type: 'Column', width: 'stretch', spacing: 'Small', items: [
              { type: 'TextBlock', text: 'PM2 updates', weight: 'Bolder', size: 'Small', wrap: true },
              { type: 'TextBlock', text: cardDate.format(new Date(first.timestamp)), size: 'Small', isSubtle: true, spacing: 'None', wrap: true },
            ] },
          ] },
          { type: 'TextBlock', text: truncate([
            first.hostname, first.environment,
            `${alerts.length} event${alerts.length === 1 ? '' : 's'}`,
          ].filter(Boolean).join(' / '), TITLE_LIMIT), size: 'Small', isSubtle: true, spacing: 'None', wrap: true },
          {
            type: 'Table', spacing: 'Small', separator: true,
            firstRowAsHeaders: true, showGridLines: false,
            horizontalCellContentAlignment: 'Left', verticalCellContentAlignment: 'Top',
            columns: [{ width: TIMELINE_TIME_WIDTH }, { width: TIMELINE_PROCESS_WEIGHT }, { width: TIMELINE_UPDATE_WEIGHT }],
            rows: [
              { type: 'TableRow', cells: [`Time (${CARD_TIME_ZONE})`, 'Process', 'Update'].map(text => ({
                type: 'TableCell', verticalContentAlignment: 'Top', items: [
                  { type: 'TextBlock', text, size: 'Small', isSubtle: true, weight: 'Bolder', horizontalAlignment: 'Left', wrap: true },
                ],
              })) },
              ...alerts.map(timelineRow),
            ],
          },
        ],
      },
    }],
  };
}

function matches(pattern: string, value: string): boolean {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${expression}$`).test(value);
}

function routeMatches(route: Route, alert: Alert): boolean {
  if (route.events.length > 0 && !route.events.some(pattern => matches(pattern, alert.type))) return false;
  if (route.severities.length > 0 && !route.severities.includes(alert.severity)) return false;
  if (route.scope === 'host' && alert.process !== undefined) return false;
  if (route.scope === 'process' && alert.process === undefined) return false;
  if (route.processes.length > 0) {
    const processMatches = alert.process
      ? route.processes.some(pattern => matches(pattern, alert.process!.name))
      : route.processes.includes('*');
    if (!processMatches) return false;
  }
  if (alert.process && route.excludeProcesses.some(pattern => matches(pattern, alert.process!.name))) return false;
  if (route.namespaces.length > 0) {
    const namespaceMatches = alert.process
      ? route.namespaces.some(pattern => matches(pattern, alert.process!.namespace ?? DEFAULT_PM2_NAMESPACE))
      : route.namespaces.includes('*');
    if (!namespaceMatches) return false;
  }
  if (alert.process && route.excludeNamespaces.some(pattern => matches(pattern, alert.process!.namespace ?? DEFAULT_PM2_NAMESPACE))) return false;
  return true;
}

export function routeDestinations(config: Pick<Config, 'routes' | 'destinations'>, alert: Alert): Destination[] {
  const ids = new Set(config.routes.filter(route => routeMatches(route, alert)).flatMap(route => route.destinations));
  return config.destinations.filter(destination => destination.enabled && ids.has(destination.id));
}

interface DispatcherDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
}

interface DestinationQueue {
  readonly destination: Destination;
  readonly alerts: Alert[];
  active: boolean;
  inFlight: number;
  timer?: ReturnType<typeof setTimeout>;
  task?: Promise<void>;
}

interface AttemptResult {
  readonly success: boolean;
  readonly retryable: boolean;
  readonly reason: 'http' | 'network' | 'timeout';
  readonly status?: number;
  readonly retryAfterMs?: number;
}

function retryAfter(value: string | null, maximum: number): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * MILLISECONDS_PER_SECOND : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.min(maximum, Math.max(0, milliseconds)) : undefined;
}

async function post(destination: Destination, body: string, config: DeliveryConfig, fetcher: typeof globalThis.fetch): Promise<AttemptResult> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('Webhook request timed out'));
    }, config.timeoutMs);
  });
  try {
    return await Promise.race([
      (async (): Promise<AttemptResult> => {
        const response = await fetcher(destination.url, {
          method: 'POST',
          headers: { ...destination.headers, 'Content-Type': 'application/json' },
          body,
          redirect: 'manual',
          signal: controller.signal,
        });
        const result: AttemptResult = {
          success: response.ok,
          retryable: response.status === HTTP_TOO_MANY_REQUESTS || (response.status >= HTTP_SERVER_ERROR_MIN && response.status <= HTTP_SERVER_ERROR_MAX),
          reason: 'http',
          status: response.status,
          retryAfterMs: retryAfter(response.headers.get('Retry-After'), config.maxDelayMs),
        };
        // Responses may contain tokens or arbitrary streams; discard them within the request deadline.
        await response.body?.cancel();
        return result;
      })(),
      deadline,
    ]);
  } catch {
    // Native fetch errors may include credential-bearing URLs, so expose only a fixed failure category.
    return { success: false, retryable: true, reason: timedOut ? 'timeout' : 'network' };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function createDispatcher(config: Pick<Config, 'delivery' | 'routes' | 'destinations'>, logger: Logger, deps: DispatcherDependencies = {}): {
  enqueue: (alert: Alert) => void;
  flush: () => Promise<void>;
  close: () => Promise<void>;
} {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? (async (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const random = deps.random ?? Math.random;
  const queues = new Map<string, DestinationQueue>();
  let failures = 0;
  let closed = false;

  const fail = (destination: Destination, message: string, fields: Readonly<Record<string, unknown>> = {}): void => {
    failures += 1;
    logger('error', message, { destination: destination.id, ...fields });
  };

  const deliver = async (destination: Destination, alerts: readonly Alert[]): Promise<void> => {
    let body: string;
    try {
      body = JSON.stringify(destination.format === 'teams' ? formatTeamsBatch(alerts) : formatPayload(destination, alerts[0]));
    } catch {
      fail(destination, 'Webhook payload could not be formatted', { event: alerts[0].type });
      return;
    }
    for (let attempt = 1; attempt <= config.delivery.maxAttempts; attempt += 1) {
      const result = await post(destination, body, config.delivery, fetcher);
      const fields = { event: alerts[0].type, count: alerts.length, attempt, reason: result.reason, ...(result.status === undefined ? {} : { status: result.status }) };
      if (result.success) {
        logger('info', 'Webhook delivered', { destination: destination.id, event: alerts[0].type, count: alerts.length, attempt });
        return;
      }
      if (!result.retryable || attempt === config.delivery.maxAttempts) {
        fail(destination, 'Webhook delivery failed', fields);
        return;
      }
      const sample = random();
      const jitter = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
      const exponential = Math.min(config.delivery.maxDelayMs, config.delivery.baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.min(config.delivery.maxDelayMs, Math.max(result.retryAfterMs ?? 0, exponential * (0.5 + jitter * 0.5)));
      logger('warn', 'Webhook delivery will retry', { destination: destination.id, ...fields, delayMs });
      await sleep(delayMs);
    }
  };

  const drain = async (queue: DestinationQueue): Promise<void> => {
    queue.active = true;
    try {
      while (queue.alerts.length > 0) {
        let batchSize = Math.min(queue.alerts.length, queue.destination.format === 'teams' ? TEAMS_BATCH_LIMIT : 1);
        if (queue.destination.format === 'teams') {
          while (batchSize > 1 && Buffer.byteLength(JSON.stringify(formatTeamsBatch(queue.alerts.slice(0, batchSize))), 'utf8') > TEAMS_PAYLOAD_LIMIT_BYTES) {
            batchSize -= 1;
          }
        }
        const alerts = queue.alerts.splice(0, batchSize);
        queue.inFlight = alerts.length;
        await deliver(queue.destination, alerts);
        queue.inFlight = 0;
      }
    } catch {
      fail(queue.destination, 'Webhook worker failed');
      if (queue.alerts.length > 0) {
        failures += queue.alerts.length;
        queue.alerts.length = 0;
      }
    } finally {
      queue.inFlight = 0;
      queue.active = false;
      queue.task = undefined;
    }
  };

  const enqueue = (alert: Alert): void => {
    if (closed) throw new Error('Webhook dispatcher is closed');
    for (const destination of routeDestinations(config, alert)) {
      const queue = queues.get(destination.id) ?? { destination, alerts: [], active: false, inFlight: 0 };
      queues.set(destination.id, queue);
      if (queue.alerts.length + queue.inFlight >= config.delivery.maxQueueSize) {
        fail(destination, 'Webhook queue is full; alert dropped', { event: alert.type });
        continue;
      }
      queue.alerts.push(alert);
      if (!queue.active && queue.timer === undefined) {
        if (destination.format === 'teams' && config.delivery.batchIntervalMs > 0) {
          queue.timer = setTimeout(() => {
            queue.timer = undefined;
            queue.task = drain(queue);
          }, config.delivery.batchIntervalMs);
        } else queue.task = drain(queue);
      }
    }
  };

  const flush = async (): Promise<void> => {
    for (;;) {
      for (const queue of queues.values()) {
        if (queue.timer !== undefined) {
          clearTimeout(queue.timer);
          queue.timer = undefined;
        }
        if (!queue.active && queue.alerts.length > 0) queue.task = drain(queue);
      }
      const tasks = [...queues.values()].flatMap(queue => queue.task ? [queue.task] : []);
      if (tasks.length === 0) break;
      await Promise.all(tasks);
    }
    if (failures > 0) throw new Error(`Webhook delivery failed for ${failures} alert delivery attempt(s)`);
  };

  const close = async (): Promise<void> => {
    closed = true;
    await flush();
  };

  return { enqueue, flush, close };
}
