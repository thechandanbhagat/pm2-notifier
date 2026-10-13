# Configuration reference

Reference for operators configuring `@thechandanbhagat/pm2-notifier`.

**Owner:** Project maintainers · **Last reviewed:** 2026-10-13 · **Review by:** 2027-01-13 or a configuration change.

Configuration is strict JSON, up to 1 MiB. Unknown object fields, duplicate destination IDs, unsupported event patterns, and references to missing destinations fail validation. Omitted optional objects receive the defaults below. JSON `null` does not mean “use the default.”

## Files and environment variables

| Setting | Purpose | Precedence |
| --- | --- | --- |
| `NOTIFIER_CONFIG` | Absolute JSON configuration path. | Runtime: environment, then PM2 module `configPath`. CLI: `--config`, then environment. |
| `NOTIFIER_ENV_FILE` | Optional Node-compatible dotenv file containing webhook secrets. | Runtime: environment, then PM2 module `envFile`. CLI: `--env-file`, then environment. |
| Variables named by `urlEnv` | Webhook URL for each enabled destination. | Existing process environment takes precedence over dotenv values. |
| Variables named by `headersEnv` | Complete HTTP header values, for example `Bearer ...`. | Existing process environment takes precedence over dotenv values. |

PM2 module settings default to empty strings. Without a configuration path the runtime stays idle; the CLI requires a path. Use absolute paths and protect the env file with mode `600`, readable by the PM2 account. Never put webhook URLs or credentials in committed JSON. Disabled destinations do not require their environment variables.

For the shipped configuration, the [README env-file setup](../README.md#2-configure-your-webhook) lists every destination's exact env entries and copyable values. Only `TEAMS_PRIMARY_WEBHOOK_URL` is required until you enable additional destinations.

Set `envFile` before `configPath` so credentials are available when monitoring starts:

```bash
pm2 set @thechandanbhagat/pm2-notifier:envFile /etc/pm2-notifier/notifier.env
pm2 set @thechandanbhagat/pm2-notifier:configPath /etc/pm2-notifier/config.json
```

The dotenv file is loaded before resolving the JSON configuration path. It can therefore also define `NOTIFIER_CONFIG`; it cannot bootstrap its own location. Changing a file requires restarting the module. Prefer the module's `envFile` setting when PM2 already runs as a daemon: exporting a variable in a different shell does not update an existing daemon environment.

## Top-level options

| Option | Default | Constraints and meaning |
| --- | --- | --- |
| `hostname` | OS hostname | Nonempty string, maximum 200 characters; alert server label. |
| `environment` | Omitted | Optional nonempty string, maximum 200 characters; for example `production`. |
| `monitor` | Defaults below | Monitoring and process selection. |
| `delivery` | Defaults below | Per-destination transport behavior. |
| `destinations` | Required | 1–100 destinations. |
| `routes` | Required | 1–500 routes; unmatched alerts are not sent. |

## Monitoring

| Option | Default | Constraints and meaning |
| --- | --- | --- |
| `monitor.pollIntervalMs` | `5000` | Integer, 500–60000; delay between completed PM2 polls. |
| `monitor.processes.include` | `["*"]` | Include process-name patterns; at least one. |
| `monitor.processes.exclude` | `[]` | Exclusions override includes. |
| `monitor.processes.includeModules` | `false` | Include other PM2 modules in process monitoring; the notifier itself is always excluded. |
| `monitor.cpu.enabled` | `true` | Enable CPU high/recovery detection. |
| `monitor.cpu.scope` | `"both"` | `"process"`, `"host"`, or `"both"`. |
| `monitor.cpu.threshold` | `95` | Number, 1–100000; upper limit is 100 for `host` or `both`. High condition is CPU ≥ threshold. |
| `monitor.cpu.durationMs` | `60000` | Integer, 1–86400000; elapsed duration of consecutive high observations. |
| `monitor.cpu.recoveryThreshold` | `80` | Number, 0–100000; must be strictly less than `threshold`. Recovery condition is CPU ≤ this value. |
| `monitor.cpu.recoveryDurationMs` | `15000` | Integer, 1–86400000; consecutive recovery observation duration. |
| `monitor.lifecycle.enabled` | `true` | Enable process lifecycle alerts. |
| `monitor.lifecycle.notifyOnStart` | `false` | Enable `process.started` alerts, including currently running processes on initial baseline. |
| `monitor.lifecycle.settleMs` | `3000` | Integer, 0–60000; allow stop/error/delete transitions to settle before classifying the notification. |

Process patterns are case-sensitive glob patterns: `*` matches any number of characters and `?` matches one. Other characters are literal; regular expressions are not supported. Pattern arrays hold at most 100 entries, each 1–200 characters. Global process filters affect process monitoring; they do not disable host CPU monitoring.

Both CPU scopes share one threshold. Process CPU measures usage relative to one logical core and may exceed 100% for a process using several cores. Host CPU measures aggregate busy time across all logical cores and stays in 0–100%. Use `scope: "process"` for thresholds above 100%.

## Destinations

| Option | Default | Constraints and meaning |
| --- | --- | --- |
| `id` | Required | Unique 1–100-character string containing letters, digits, `_`, or `-`. |
| `format` | Required | `"teams"`, `"slack"`, `"discord"`, or `"generic"`. |
| `urlEnv` | Required | Environment-variable name containing the webhook URL. |
| `headersEnv` | `{}` | Map of HTTP header names to environment-variable names containing their values. |
| `enabled` | `true` | Disabled destinations are skipped and do not resolve secrets. |
| `allowInsecureHttp` | `false` | Explicitly permit `http:` for controlled local/private receivers; otherwise HTTPS is required. |
| `template` | Omitted | Any JSON value; allowed only with `generic`. Omission sends the complete alert object. |

Environment-variable names must match `[A-Za-z_][A-Za-z0-9_]*`. Required values must be nonempty. URLs must use HTTPS, or explicitly permitted HTTP, with no username/password or fragment. URL query parameters are supported for provider webhook tokens. HTTP redirects are not followed.

Requests always use `POST` and `Content-Type: application/json`. Custom header names must be valid HTTP tokens. `Host`, `Content-Length`, `Content-Type`, `Connection`, `Transfer-Encoding`, `Upgrade`, and `Proxy-*` cannot be overridden. Header values cannot contain newlines or other invalid control characters. Store a whole authorization value, including its scheme, in the referenced environment variable.

Provider formats are Teams Adaptive Card 1.2 message envelopes, Slack incoming-webhook messages, and Discord webhook embeds. Each webhook selects its own destination channel. Register several destination objects for several channels or workspaces.

## Routes

| Option | Default | Constraints and meaning |
| --- | --- | --- |
| `destinations` | Required | 1–100 existing destination IDs. |
| `events` | `["*"]` | 1–100 supported event types/patterns. |
| `processes` | `["*"]` | Include process-name patterns; at least one. |
| `excludeProcesses` | `[]` | Process-name exclusions, taking precedence over includes. |
| `severities` | `["info", "warning", "critical"]` | Nonempty list of these exact severities. |
| `scope` | `"all"` | `"all"`, `"host"`, or `"process"`. |

Supported events are `cpu.high`, `cpu.recovered`, `process.started`, `process.restarted`, `process.stopped`, `process.errored`, `process.deleted`, and `notifier.test`. Supported event patterns are exactly `*`, `cpu.*`, `process.*`, and `notifier.*`; arbitrary event wildcards fail validation.

Filters in a route are combined with AND. Entries within a filter are alternatives. Host alerts have no process name and match the process filter only when it contains `"*"`; process-specific include patterns exclude host alerts. `excludeProcesses` applies only to process alerts. Use `scope: "process"` when the route should never receive host alerts. Several routes may match; each enabled destination receives the alert once, even when repeated across routes. Separate destination IDs pointing at the same URL are separate deliveries.

`processes` matches PM2 process names, not PM2's `namespace` field. For a complete process-name-prefix mapping to several channels, use the [channel-group sample](../examples/channel-groups.config.json) and its [setup instructions](../README.md#route-application-groups-to-channel-groups).

Example route for restart/stop/error alerts from API workers:

```json
{
  "destinations": ["slack-operations", "teams-primary"],
  "events": ["process.*"],
  "processes": ["api-*"],
  "excludeProcesses": ["api-canary"],
  "severities": ["info", "warning", "critical"],
  "scope": "process"
}
```

## Generic JSON templates

Substitute an own-property path in the alert using `{{path}}`. Paths use letters, digits, underscores, and dots, such as `{{process.name}}`; spaces inside the braces are allowed. Templates operate recursively on JSON values; object keys are unchanged. There is no expression evaluation, scripting, environment-variable interpolation, or request signing.

```json
{
  "id": "incident-webhook",
  "format": "generic",
  "urlEnv": "INCIDENT_WEBHOOK_URL",
  "headersEnv": { "Authorization": "INCIDENT_WEBHOOK_AUTHORIZATION" },
  "template": {
    "subject": "{{hostname}} / {{type}}",
    "message": "{{message}}",
    "cpuPercent": "{{details.cpu}}",
    "process": "{{process}}",
    "metadata": "{{details}}"
  }
}
```

A value consisting entirely of one token preserves the source type, including numbers, booleans, objects, arrays, and null. Missing standalone paths become JSON `null`. Tokens embedded in longer strings become text; missing/null values become empty strings and object values become compact JSON. Thus `"{{details.cpu}}"` becomes a number for CPU alerts and `null` for a stop alert.

The default generic alert shape is:

```json
{
  "id": "unique-alert-id",
  "type": "cpu.high",
  "severity": "critical",
  "timestamp": "2026-09-14T12:00:00.000Z",
  "hostname": "app-server-01",
  "environment": "production",
  "process": { "name": "api", "pmId": 0, "pid": 1234 },
  "message": "Human-readable alert description",
  "details": { "scope": "process", "cpu": 100, "threshold": 95, "durationMs": 60000 }
}
```

`environment` is omitted when not configured. Host alerts omit `process`; a process `pid` may be unavailable. CPU details include `scope`, `cpu`, `threshold`, and `durationMs`; recovery adds `recoveryThreshold` and `recoveryDurationMs`. Lifecycle details include `scope`, `status`, `restarts`, `exitCode` (possibly null), and `reason`. `notifier.test` has `details.scope: "host"`.

## Delivery

| Option | Default | Constraints and meaning |
| --- | --- | --- |
| `delivery.batchIntervalMs` | `30000` | Integer, 0–86400000; Teams grouping window from the first pending event. `0` sends immediately. Cards hold up to 20 events; larger batches or payloads exceeding 28000 bytes split. Flush, CLI tests, and shutdown send immediately. Other formats keep individual messages. |
| `delivery.timeoutMs` | `10000` | Integer, 100–120000; timeout per HTTP attempt. |
| `delivery.maxAttempts` | `4` | Integer, 1–10; includes the initial attempt. |
| `delivery.baseDelayMs` | `1000` | Integer, 1–86400000; initial retry backoff ceiling. |
| `delivery.maxDelayMs` | `30000` | Integer, 1–86400000; caps retry delays; must be at least `baseDelayMs`. |
| `delivery.maxQueueSize` | `500` | Integer, 1–10000; active plus pending notifications per destination. |

See [delivery guarantees](architecture.md#delivery-guarantees) before choosing retry and queue settings.

## CLI

For a PM2-installed package, locate the CLI under the same account and `PM2_HOME` used by your applications:

```bash
NOTIFIER_PACKAGE_DIR="${PM2_HOME:-$HOME/.pm2}/modules/@thechandanbhagat/pm2-notifier/node_modules/@thechandanbhagat/pm2-notifier"
node "$NOTIFIER_PACKAGE_DIR/dist/cli.js" --help
```

```text
node "$NOTIFIER_PACKAGE_DIR/dist/cli.js" validate --config PATH [--env-file PATH]
node "$NOTIFIER_PACKAGE_DIR/dist/cli.js" test --config PATH [--env-file PATH] [--destination ID]
```

`validate` parses JSON, validates routes, and resolves credentials without contacting PM2 or a webhook. `test` sends an actual info-severity `notifier.test` alert with host scope. Without `--destination`, normal routing applies; no match is an error. With `--destination`, the selected enabled destination is tested directly, bypassing its route filters. The CLI exits nonzero on invalid configuration or failed delivery. A successful HTTP response confirms endpoint acceptance, not that a downstream workflow posted to a channel.
