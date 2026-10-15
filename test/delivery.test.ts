import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { LOGO_DATA_URI } from '../src/branding';
import { createDispatcher, formatPayload, routeDestinations } from '../src/delivery';
import type { Alert, Config, Destination, JsonValue, Logger, Route } from '../src/types';

const MAX_TEAMS_PAYLOAD_BYTES = 28_000;
const MAX_TEAMS_LOGO_BYTES = 8 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const ALERT: Alert = {
  id: 'event-1', type: 'cpu.high', severity: 'critical', timestamp: '2026-09-14T10:00:00.000Z', hostname: 'server-a',
  process: { name: 'api.worker', pmId: 3, pid: 123 }, message: 'CPU reached 100%', details: { cpu: 100, reason: null, healthy: false },
};
const destination = (id = 'primary', overrides: Partial<Destination> = {}): Destination => ({ id, format: 'generic', url: `https://example.invalid/${id}?token=secret`, headers: {}, enabled: true, ...overrides });
const route = (overrides: Partial<Route> = {}): Route => ({ destinations: ['primary'], events: ['*'], processes: [], excludeProcesses: [], namespaces: ['*'], excludeNamespaces: [], severities: [], scope: 'all', ...overrides });
const config = (overrides: Partial<Pick<Config, 'delivery' | 'destinations' | 'routes'>> = {}): Pick<Config, 'delivery' | 'destinations' | 'routes'> => ({
  delivery: { batchIntervalMs: 0, timeoutMs: 100, maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, maxQueueSize: 5 }, destinations: [destination()], routes: [route()], ...overrides,
});
const quiet: Logger = () => undefined;
const asObject = (value: JsonValue): Record<string, JsonValue> => value as Record<string, JsonValue>;
const fakeFetch = (handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch => handler as typeof fetch;
const ok = async (): Promise<Response> => new Response(null, { status: 204 });

test('generic format preserves every alert field and renders nested templates without coercing whole values', () => {
  assert.deepEqual(formatPayload(destination(), ALERT), ALERT);
  assert.deepEqual(formatPayload(destination('custom', { template: {
    cpu: '{{details.cpu}}', process: '{{process}}', details: '{{details}}', reason: '{{details.reason}}', missing: '{{details.missing}}',
    message: '{{process.name}}: {{details.cpu}} / {{details.reason}} / {{missing}}', array: ['{{details.healthy}}', null, 0], literal: '',
    inherited: '{{process.toString}}',
  } }), ALERT), {
    cpu: 100, process: ALERT.process, details: ALERT.details, reason: null, missing: null,
    message: 'api.worker: 100 /  / ', array: [false, null, 0], literal: '', inherited: null,
  });
  assert.equal(formatPayload(destination('custom', { template: null }), ALERT), null);
  assert.deepEqual(formatPayload(destination('custom', { template: [] }), ALERT), []);
});

test('formats Teams adaptive card envelope, Slack safe text and Discord with mentions disabled', () => {
  const hostile = { ...ALERT, message: '<!channel> <@U123> @everyone @here <https://secret.invalid|click>' };
  const teams = asObject(formatPayload(destination('teams', { format: 'teams' }), ALERT));
  assert.equal(teams.type, 'message');
  const attachment = asObject((teams.attachments as JsonValue[])[0]);
  assert.equal(attachment.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(asObject(attachment.content).type, 'AdaptiveCard');
  const slack = asObject(formatPayload(destination('slack', { format: 'slack' }), hostile));
  assert.equal(slack.mrkdwn, false);
  assert.equal(slack.link_names, false);
  assert.equal(slack.unfurl_links, false);
  assert.equal(slack.unfurl_media, false);
  assert.ok(!(slack.text as string).includes('<!channel>'));
  assert.ok(!(slack.text as string).includes('@everyone'));
  const discord = asObject(formatPayload(destination('discord', { format: 'discord' }), hostile));
  assert.deepEqual(discord.allowed_mentions, { parse: [] });
  assert.ok(Array.isArray(discord.embeds));
});

test('provider text remains bounded for oversized messages and empty optional values', () => {
  const large: Alert = { ...ALERT, message: 'x'.repeat(100_000), process: undefined, environment: '', details: {} };
  const slack = asObject(formatPayload(destination('slack', { format: 'slack' }), large));
  assert.ok((slack.text as string).length < 3_000);
  const discord = asObject(formatPayload(destination('discord', { format: 'discord' }), large));
  const embed = asObject((discord.embeds as JsonValue[])[0]);
  assert.ok((embed.description as string).length <= 4_000);
  assert.ok(JSON.stringify(formatPayload(destination('teams', { format: 'teams' }), large)).length < 28_000);
});

test('Teams shows a full UTC date, each event time and an embedded PNG logo linked to GitHub without a bottom button', () => {
  const payload = asObject(formatPayload(destination('teams', { format: 'teams' }), {
    ...ALERT, timestamp: '2026-01-10T00:05:06+02:00', process: undefined, environment: undefined,
  }));
  const card = asObject(asObject((payload.attachments as JsonValue[])[0]).content);
  const body = card.body as JsonValue[];
  const header = asObject(body[0]);
  assert.equal(header.type, 'ColumnSet');
  const columns = header.columns as JsonValue[];
  const logo = asObject((asObject(columns[0]).items as JsonValue[])[0]);
  assert.equal(logo.type, 'Image');
  assert.equal(logo.url, LOGO_DATA_URI);
  assert.match(logo.url as string, /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
  const image = Buffer.from((logo.url as string).split(',')[1], 'base64');
  assert.deepEqual(image.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  assert.ok(image.length <= MAX_TEAMS_LOGO_BYTES);
  assert.deepEqual(image, readFileSync(resolve(__dirname, '../assets/pm2-notifier-logo-card.png')));
  const heading = asObject(columns[1]).items as JsonValue[];
  assert.equal(asObject(heading[0]).text, 'PM2 updates');
  assert.equal(asObject(heading[1]).text, '9 January 2026');
  assert.equal(asObject(body[1]).text, 'server-a / 1 event');
  const table = asObject(body[2]);
  const rows = table.rows as JsonValue[];
  const labels = asObject(rows[0]).cells as JsonValue[];
  assert.deepEqual(labels.map(cell => asObject((asObject(cell).items as JsonValue[])[0]).text), ['Time (UTC)', 'Process', 'Update']);
  const event = asObject(rows[1]);
  assert.equal(event.type, 'TableRow');
  const eventCells = event.cells as JsonValue[];
  const time = asObject((asObject(eventCells[0]).items as JsonValue[])[0]);
  assert.equal(time.text, '22:05:06');
  assert.equal(time.wrap, false);
  assert.equal(time.fontType, 'Monospace');
  const processItems = asObject(eventCells[1]).items as JsonValue[];
  assert.equal(processItems.length, 1);
  assert.equal(asObject(processItems[0]).text, 'server-a');
  const update = asObject(eventCells[2]).items as JsonValue[];
  assert.equal(asObject(update[0]).text, 'High CPU');
  assert.equal(asObject(update[1]).text, '100%');
  assert.equal(Object.hasOwn(card, 'actions'), false);
  const github = asObject(logo.selectAction);
  assert.equal(github.type, 'Action.OpenUrl');
  assert.equal(github.url, 'https://github.com/thechandanbhagat/pm2-notifier');
});

test('Teams aligns header and events with one shared table column definition', () => {
  const payload = asObject(formatPayload(destination('teams', { format: 'teams' }), ALERT));
  const card = asObject(asObject((payload.attachments as JsonValue[])[0]).content);
  assert.equal(card.version, '1.5');
  const body = card.body as JsonValue[];
  assert.equal(body.length, 3);
  const table = asObject(body[2]);
  assert.equal(table.type, 'Table');
  assert.deepEqual(table.columns, [{ width: '72px' }, { width: 2 }, { width: 3 }]);
  assert.equal(table.spacing, 'Small');
  assert.equal(table.separator, true);
  assert.equal(table.showGridLines, false);
  assert.equal(table.firstRowAsHeaders, true);
  assert.equal(table.horizontalCellContentAlignment, 'Left');
  assert.equal(table.verticalCellContentAlignment, 'Top');
  const rows = table.rows as JsonValue[];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const object = asObject(row);
    assert.equal(object.type, 'TableRow');
    assert.equal(Object.hasOwn(object, 'columns'), false);
    assert.equal(Object.hasOwn(object, 'separator'), false);
    const cells = object.cells as JsonValue[];
    assert.equal(cells.length, 3);
    for (const cell of cells) {
      const object = asObject(cell);
      assert.equal(object.type, 'TableCell');
      assert.equal(Object.hasOwn(object, 'width'), false);
      assert.equal(Object.hasOwn(object, 'style'), false);
      assert.ok((object.items as JsonValue[]).every(item => asObject(item).type === 'TextBlock'));
    }
  }
  const cells = asObject(rows[1]).cells as JsonValue[];
  for (const cell of cells) assert.equal(asObject(cell).verticalContentAlignment, 'Top');
  const time = asObject((asObject(cells[0]).items as JsonValue[])[0]);
  assert.equal(time.horizontalAlignment, 'Left');
});

test('routing matches glob events, literal regex characters, scopes, severity and process exclusions, deduplicating destinations', () => {
  const first = destination();
  const other = destination('other');
  const disabled = destination('disabled', { enabled: false });
  const settings = config({ destinations: [first, other, disabled], routes: [
    route({ events: ['cpu.*'], processes: ['api.?orker'], severities: ['critical'], destinations: ['primary', 'primary', 'disabled'] }),
    route({ events: ['cpu.high'], destinations: ['primary'] }),
    route({ destinations: ['other'], excludeProcesses: ['api.*'] }),
  ] });
  assert.deepEqual(routeDestinations(settings, ALERT), [first]);
  assert.deepEqual(routeDestinations(config({ routes: [] }), ALERT), []);
  assert.deepEqual(routeDestinations(config({ destinations: [] }), ALERT), []);
  assert.deepEqual(routeDestinations(config({ routes: [route({ processes: ['apiXworker'] })] }), ALERT), []);
  assert.deepEqual(routeDestinations(config({ routes: [route({ scope: 'host' })] }), ALERT), []);
  assert.deepEqual(routeDestinations(config({ routes: [route({ severities: ['info'] })] }), ALERT), []);
  assert.deepEqual(routeDestinations(config({ routes: [route({ events: ['process.*'] })] }), ALERT), []);
  const host: Alert = { ...ALERT, process: undefined };
  assert.deepEqual(routeDestinations(config({ routes: [route({ scope: 'process' })] }), host), []);
  assert.deepEqual(routeDestinations(config({ routes: [route({ processes: ['api.*'] })] }), host), []);
  assert.deepEqual(routeDestinations(config({ routes: [route({ processes: ['*'] })] }), host), [first]);
  assert.deepEqual(routeDestinations(config({ routes: [route({ scope: 'host' })] }), host), [first]);
});

test('namespace routing matches exact names and globs literally and case-sensitively', () => {
  const cases = [
    ['payments', 'payments', true],
    ['payments', 'payments-worker', false],
    ['payments', 'Payments', false],
    ['payments-*', 'payments-eu', true],
    ['payments-?', 'payments-a', true],
    ['payments-?', 'payments-ab', false],
    ['namespace.v1+[blue]($)', 'namespace.v1+[blue]($)', true],
    ['namespace.v1+[blue]($)', 'namespaceXv11b', false],
    ['default', undefined, true],
    ['payments', undefined, false],
    ['default', 'default', true],
    ['*', 'payments', true],
  ] as const;
  for (const [pattern, namespace, expected] of cases) {
    const alert: Alert = { ...ALERT, process: { ...ALERT.process!, namespace } };
    const result = routeDestinations(config({ routes: [route({ namespaces: [pattern] })] }), alert);
    assert.deepEqual(result.map(target => target.id), expected ? ['primary'] : [], `${pattern} against ${namespace}`);
  }
});

test('namespace exclusions override included matches and combine with process, severity, event and scope filters', () => {
  const alert: Alert = { ...ALERT, process: { ...ALERT.process!, namespace: 'payments-eu' } };
  const matching = route({ namespaces: ['payments-*'], excludeNamespaces: ['payments-sandbox'], processes: ['api.*'], events: ['cpu.*'], severities: ['critical'], scope: 'process' });
  assert.deepEqual(routeDestinations(config({ routes: [matching] }), alert).map(target => target.id), ['primary']);
  for (const overrides of [
    { excludeNamespaces: ['payments-eu'] },
    { excludeNamespaces: ['payments-?u'] },
    { excludeNamespaces: ['*'] },
    { namespaces: ['orders-*'] },
    { processes: ['worker-*'] },
    { excludeProcesses: ['api.*'] },
    { events: ['process.*'] },
    { severities: ['info'] as const },
    { scope: 'host' as const },
  ]) assert.deepEqual(routeDestinations(config({ routes: [{ ...matching, ...overrides }] }), alert), []);
  assert.deepEqual(routeDestinations(config({ routes: [route({ excludeNamespaces: ['default'] })] }), ALERT), []);
});

test('host alerts require the wildcard namespace and ignore process namespace exclusions', () => {
  const host: Alert = { ...ALERT, process: undefined };
  for (const namespaces of [['payments'], ['default'], ['payments-*'], ['**']]) {
    assert.deepEqual(routeDestinations(config({ routes: [route({ namespaces })] }), host), []);
  }
  for (const namespaces of [['*'], ['payments', '*']]) {
    const matching = route({ namespaces, excludeNamespaces: ['*'], scope: 'host' });
    assert.deepEqual(routeDestinations(config({ routes: [matching] }), host).map(target => target.id), ['primary']);
  }
  assert.deepEqual(routeDestinations(config({ routes: [route({ namespaces: ['*'], scope: 'process' })] }), host), []);
});

test('identical process names in separate namespaces route to their channel groups without duplicate deliveries', () => {
  const primary = destination();
  const payments = destination('payments');
  const orders = destination('orders');
  const disabled = destination('disabled', { enabled: false });
  const settings = config({ destinations: [primary, payments, orders, disabled], routes: [
    route({ namespaces: ['payments'], destinations: ['primary', 'payments', 'payments', 'disabled'] }),
    route({ namespaces: ['payments*'], destinations: ['payments'] }),
    route({ namespaces: ['orders'], destinations: ['orders'] }),
  ] });
  const process = { name: 'worker', pmId: 3 };
  assert.deepEqual(routeDestinations(settings, { ...ALERT, process: { ...process, namespace: 'payments' } }), [primary, payments]);
  assert.deepEqual(routeDestinations(settings, { ...ALERT, process: { ...process, namespace: 'orders' } }), [orders]);
  assert.deepEqual(routeDestinations(settings, { ...ALERT, process: { ...process, namespace: 'unknown' } }), []);
});

test('dispatcher posts JSON and safe custom headers, refuses redirects, and drains before closing', async () => {
  const calls: RequestInit[] = [];
  const dispatcher = createDispatcher(config({ destinations: [destination('primary', { headers: { Authorization: 'Bearer sensitive' } })] }), quiet, {
    fetch: fakeFetch(async (_input, init) => { calls.push(init!); return ok(); }),
  });
  dispatcher.enqueue(ALERT);
  await dispatcher.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].redirect, 'manual');
  assert.deepEqual(JSON.parse(calls[0].body as string), ALERT);
  assert.equal((calls[0].headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.equal((calls[0].headers as Record<string, string>).Authorization, 'Bearer sensitive');
  assert.throws(() => dispatcher.enqueue(ALERT), /closed/);
  await dispatcher.close();
});

test('retries network failures and rate limits with capped retry-after delays', async () => {
  const delays: number[] = [];
  let attempts = 0;
  const dispatcher = createDispatcher(config(), quiet, {
    fetch: fakeFetch(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('https://secret.invalid/token');
      if (attempts === 2) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '999' } });
      return ok();
    }),
    sleep: async ms => { delays.push(ms); }, random: () => 1,
  });
  dispatcher.enqueue(ALERT);
  await dispatcher.flush();
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 50]);
});

test('retries server errors to exhaustion without leaking URLs, headers, body or exception text', async () => {
  const logs: unknown[] = [];
  const delays: number[] = [];
  let attempts = 0;
  const dispatcher = createDispatcher(config({ destinations: [destination('primary', { headers: { Authorization: 'token-private' } })] }), (...args) => { logs.push(args); }, {
    fetch: fakeFetch(async () => { attempts += 1; return new Response('server-private', { status: 503 }); }),
    sleep: async ms => { delays.push(ms); }, random: () => 0,
  });
  dispatcher.enqueue({ ...ALERT, message: 'message-private' });
  await assert.rejects(dispatcher.flush(), /Webhook delivery failed for 1/);
  await assert.rejects(dispatcher.close(), /Webhook delivery failed for 1/);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5, 10]);
  assert.doesNotMatch(JSON.stringify(logs), /token-private|server-private|message-private|https:|secret/);
});

test('permanent client errors and redirects do not retry', async () => {
  for (const status of [301, 302, 400, 401, 403, 404]) {
    let attempts = 0;
    const dispatcher = createDispatcher(config(), quiet, {
      fetch: fakeFetch(async () => { attempts += 1; return new Response(null, { status }); }),
      sleep: async () => { assert.fail('Unexpected retry'); },
    });
    dispatcher.enqueue(ALERT);
    await assert.rejects(dispatcher.flush(), /Webhook delivery failed/);
    assert.equal(attempts, 1);
  }
});

test('queues are bounded including active delivery, and one blocked destination cannot block another', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const settings = config({ destinations: [destination('primary'), destination('other')], routes: [route({ destinations: ['primary', 'other'] })] });
  const dispatcher = createDispatcher({ ...settings, delivery: { ...settings.delivery, maxQueueSize: 1 } }, quiet, {
    fetch: fakeFetch(async input => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/primary')) await gate;
      return ok();
    }),
  });
  dispatcher.enqueue(ALERT);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  dispatcher.enqueue({ ...ALERT, id: 'event-2' });
  release!();
  await assert.rejects(dispatcher.flush(), /Webhook delivery failed for 1/);
  assert.equal(calls.filter(url => url.includes('/other')).length, 2);
  assert.equal(calls.filter(url => url.includes('/primary')).length, 1);
});

test('timeouts cover unresponsive fetch and unresponsive response disposal and redact exceptions', async () => {
  const settings = config();
  for (const mode of ['fetch', 'body']) {
    const logs: unknown[] = [];
    let signal: AbortSignal | null | undefined;
    const dispatcher = createDispatcher({ ...settings, delivery: { ...settings.delivery, timeoutMs: 10, maxAttempts: 1 } }, (...args) => { logs.push(args); }, {
      fetch: fakeFetch(async (_input, init) => {
        signal = init?.signal;
        if (mode === 'fetch') return new Promise<Response>(() => undefined);
        return new Response(new ReadableStream({ cancel: () => new Promise<void>(() => undefined) }));
      }),
    });
    dispatcher.enqueue(ALERT);
    await assert.rejects(dispatcher.flush(), /Webhook delivery failed/);
    assert.equal(signal?.aborted, true);
    assert.match(JSON.stringify(logs), /timeout/);
    assert.doesNotMatch(JSON.stringify(logs), /secret|https:/);
  }
});

test('empty dispatcher flushes and closes without fetching; network errors remain redacted', async () => {
  const empty = createDispatcher(config({ routes: [] }), quiet, { fetch: fakeFetch(async () => { assert.fail('Unexpected fetch'); }) });
  empty.enqueue(ALERT);
  await empty.flush();
  await empty.close();
  const settings = config();
  const logs: unknown[] = [];
  const failing = createDispatcher({ ...settings, delivery: { ...settings.delivery, maxAttempts: 1 } }, (...args) => { logs.push(args); }, {
    fetch: fakeFetch(async () => { throw new Error('Bearer very-secret at https://secret.invalid'); }),
  });
  failing.enqueue(ALERT);
  await assert.rejects(failing.close(), /Webhook delivery failed/);
  assert.doesNotMatch(JSON.stringify(logs), /Bearer|very-secret|https:/);
});

test('native fetch sends only to the configured loopback endpoint and never follows its redirect', async () => {
  const requests: Array<{ path: string; authorization: string | undefined; body: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url!, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
    if (request.url === '/redirect') response.writeHead(307, { Location: '/must-not-receive-credentials' });
    else response.writeHead(204);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    for (const path of ['/ok', '/redirect']) {
      const dispatcher = createDispatcher(config({ destinations: [destination('primary', {
        url: `http://127.0.0.1:${address.port}${path}`, headers: { Authorization: 'Bearer local-fixture' },
      })] }), quiet);
      dispatcher.enqueue(ALERT);
      if (path === '/ok') await dispatcher.close();
      else await assert.rejects(dispatcher.close(), /Webhook delivery failed/);
    }
    assert.deepEqual(requests.map(request => request.path), ['/ok', '/redirect']);
    assert.equal(requests[0].authorization, 'Bearer local-fixture');
    assert.deepEqual(JSON.parse(requests[0].body), ALERT);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});


test('Teams batches on a fixed interval without resetting it for later events', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: JsonValue[] = [];
  const settings = config({ destinations: [destination('primary', { format: 'teams' })] });
  const dispatcher = createDispatcher({ ...settings, delivery: { ...settings.delivery, batchIntervalMs: 30_000 } }, quiet, {
    fetch: fakeFetch(async (_input, init) => { calls.push(JSON.parse(init!.body as string)); return ok(); }),
  });
  dispatcher.enqueue(ALERT);
  context.mock.timers.tick(20_000);
  dispatcher.enqueue({ ...ALERT, id: 'second', type: 'process.restarted', timestamp: '2026-09-14T10:00:20.000Z', message: 'Worker restarted' });
  assert.equal(calls.length, 0);
  context.mock.timers.tick(10_000);
  assert.equal(calls.length, 1);
  await dispatcher.close();
  const card = asObject(asObject((asObject(calls[0]).attachments as JsonValue[])[0]).content);
  const body = card.body as JsonValue[];
  assert.equal(body.length, 3);
  const heading = asObject((asObject(body[0]).columns as JsonValue[])[1]).items as JsonValue[];
  assert.equal(asObject(heading[0]).text, 'PM2 updates');
  assert.equal(asObject(heading[1]).text, '14 September 2026');
  assert.equal(asObject(body[1]).text, 'server-a / 2 events');
  const rows = (asObject(body[2]).rows as JsonValue[]).slice(1).map(row => {
    const cells = asObject(row).cells as JsonValue[];
    const update = asObject(cells[2]).items as JsonValue[];
    return {
      time: asObject((asObject(cells[0]).items as JsonValue[])[0]).text,
      process: (asObject(cells[1]).items as JsonValue[]).map(item => asObject(item).text),
      update: update.map(item => asObject(item).text),
    };
  });
  assert.deepEqual(rows, [
    { time: '10:00:00', process: ['api.worker', 'PM2 3'], update: ['High CPU', '100%'] },
    { time: '10:00:20', process: ['api.worker', 'PM2 3'], update: ['Restarted', '100%'] },
  ]);
  assert.doesNotMatch(JSON.stringify(card), /cpu.high|process.restarted|#3|2026-09-14T/);
});

test('Teams flush splits maximum queues into bounded cards without losing alerts', async () => {
  const alertCount = 500;
  const batchLimit = 20;
  const secondMs = 1_000;
  const calls: JsonValue[] = [];
  const settings = config({ destinations: [destination('primary', { format: 'teams' })] });
  const dispatcher = createDispatcher({ ...settings, delivery: { ...settings.delivery, batchIntervalMs: 30_000, maxQueueSize: alertCount } }, quiet, {
    fetch: fakeFetch(async (_input, init) => { calls.push(JSON.parse(init!.body as string)); return ok(); }),
  });
  const expectedTimes = Array.from({ length: alertCount }, (_unused, index) => {
    const timestamp = new Date(Date.parse(ALERT.timestamp) + index * secondMs).toISOString();
    dispatcher.enqueue({ ...ALERT, id: String(index), timestamp, message: 'x'.repeat(100_000) });
    return timestamp.slice(11, 19);
  });
  await dispatcher.close();
  assert.equal(calls.length, alertCount / batchLimit);
  const deliveredTimes = calls.flatMap(payload => {
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') < MAX_TEAMS_PAYLOAD_BYTES);
    const card = asObject(asObject((asObject(payload).attachments as JsonValue[])[0]).content);
    const table = asObject((card.body as JsonValue[])[2]);
    const rows = (table.rows as JsonValue[]).slice(1);
    assert.equal(rows.length, batchLimit);
    return rows.map(row => {
      const timeCell = asObject((asObject(row).cells as JsonValue[])[0]);
      return asObject((timeCell.items as JsonValue[])[0]).text;
    });
  });
  assert.deepEqual(deliveredTimes, expectedTimes);
});

test('Teams splits multibyte timeline rows by payload bytes while retaining every event in order', async () => {
  const alertCount = 20;
  const maximumProcessLength = 200;
  const oversizedExitLength = 100_000;
  const secondMs = 1_000;
  const batchIntervalMs = 30_000;
  const calls: JsonValue[] = [];
  const settings = config({ destinations: [destination('primary', { format: 'teams' })] });
  const dispatcher = createDispatcher({ ...settings, delivery: { ...settings.delivery, batchIntervalMs, maxQueueSize: alertCount } }, quiet, {
    fetch: fakeFetch(async (_input, init) => { calls.push(JSON.parse(init!.body as string)); return ok(); }),
  });
  const expectedTimes = Array.from({ length: alertCount }, (_unused, index) => {
    const timestamp = new Date(Date.parse(ALERT.timestamp) + index * secondMs).toISOString();
    dispatcher.enqueue({
      ...ALERT, id: `multibyte-${index}`, type: 'process.stopped', timestamp,
      process: { name: '服'.repeat(maximumProcessLength), pmId: 3 }, details: { exitCode: '故'.repeat(oversizedExitLength) },
    });
    return timestamp.slice(11, 19);
  });
  await dispatcher.close();
  assert.ok(calls.length > 1);
  const deliveredTimes = calls.flatMap(payload => {
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_TEAMS_PAYLOAD_BYTES);
    const card = asObject(asObject((asObject(payload).attachments as JsonValue[])[0]).content);
    const table = asObject((card.body as JsonValue[])[2]);
    return (table.rows as JsonValue[]).slice(1).map(row => {
      const timeCell = asObject((asObject(row).cells as JsonValue[])[0]);
      return asObject((timeCell.items as JsonValue[])[0]).text;
    });
  });
  assert.deepEqual(deliveredTimes, expectedTimes);
});


test('Teams explains clean, failed and unavailable exit codes without inventing a cause', () => {
  const cases = [
    [0, 'Exit 0 - clean exit'],
    ['0', 'Exit 0 - clean exit'],
    [1, 'Exit 1 - usually indicates failure; meaning depends on the application'],
    [Number.MAX_SAFE_INTEGER, `Exit ${Number.MAX_SAFE_INTEGER} - usually indicates failure; meaning depends on the application`],
    ['SIGTERM', 'Exit SIGTERM - usually indicates failure; meaning depends on the application'],
    [null, 'Exit unknown - PM2 did not provide a code'],
    ['', 'Exit unknown - PM2 did not provide a code'],
  ] as const;
  for (const [exitCode, description] of cases) {
    const payload = asObject(formatPayload(destination('teams', { format: 'teams' }), {
      ...ALERT, type: 'process.stopped', details: { exitCode },
    }));
    const card = asObject(asObject((payload.attachments as JsonValue[])[0]).content);
    const table = asObject((card.body as JsonValue[])[2]);
    const cells = asObject((table.rows as JsonValue[])[1]).cells as JsonValue[];
    const update = asObject(cells[2]).items as JsonValue[];
    assert.equal(asObject(update[0]).text, 'Stopped');
    assert.equal(asObject(update[1]).text, description);
    assert.equal(asObject(update[1]).wrap, true);
    assert.equal(asObject(update[1]).spacing, 'None');
  }
  const withoutExit = JSON.stringify(formatPayload(destination('teams', { format: 'teams' }), { ...ALERT, details: {} }));
  assert.doesNotMatch(withoutExit, /Exit /);
});

test('Teams keeps long process names and detail text wrapping, preserves PM2 zero and uses severity colors', () => {
  const processName = 'service-'.repeat(100);
  const severities = [['info', 'Default'], ['warning', 'Warning'], ['critical', 'Attention']] as const;
  for (const [severity, color] of severities) {
    const payload = asObject(formatPayload(destination('teams', { format: 'teams' }), {
      ...ALERT, severity, process: { name: processName, pmId: 0 }, details: {},
    }));
    const card = asObject(asObject((payload.attachments as JsonValue[])[0]).content);
    const table = asObject((card.body as JsonValue[])[2]);
    assert.deepEqual(table.columns, [{ width: '72px' }, { width: 2 }, { width: 3 }]);
    const cells = asObject((table.rows as JsonValue[])[1]).cells as JsonValue[];
    const process = asObject(cells[1]).items as JsonValue[];
    assert.equal(asObject(process[0]).text, `${processName.slice(0, 199)}…`);
    assert.equal(asObject(process[0]).wrap, true);
    assert.equal(asObject(process[1]).text, 'PM2 0');
    const update = asObject(cells[2]).items as JsonValue[];
    assert.equal(update.length, 1);
    assert.equal(asObject(update[0]).color, color);
    assert.equal(asObject(update[0]).wrap, true);
  }
});
