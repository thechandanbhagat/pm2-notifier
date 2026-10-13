# pm2-notifier

A PM2 module for server operators that sends sustained CPU, restart, stop, and crash alerts to any combination of Teams, Slack, Discord, and JSON webhooks.

[npm package](https://www.npmjs.com/package/@thechandanbhagat/pm2-notifier) · [Releases](https://github.com/thechandanbhagat/pm2-notifier/releases)

**Owner:** Project maintainers · **Last reviewed:** 2026-10-13 · **Review by:** 2027-01-13 or the next release.

## Quick start

These steps target Linux servers with PM2 already managing your applications. You need Node.js 22 or newer and npm. Run PM2 commands as the same OS user and with the same `PM2_HOME` as those applications.

### 1. Install the module

```bash
pm2 install @thechandanbhagat/pm2-notifier
NOTIFIER_PACKAGE_DIR="${PM2_HOME:-$HOME/.pm2}/modules/@thechandanbhagat/pm2-notifier/node_modules/@thechandanbhagat/pm2-notifier"
```

The module stays idle until you set its configuration path. Keep `NOTIFIER_PACKAGE_DIR` defined for the commands below; it points to the package installed by PM2.

### 2. Configure your webhook

Keep configuration and credentials outside the installed package:

```bash
sudo install -d -m 750 -o "$(id -un)" -g "$(id -gn)" /etc/pm2-notifier
install -m 600 "$NOTIFIER_PACKAGE_DIR/examples/notifier.config.json" /etc/pm2-notifier/config.json
touch /etc/pm2-notifier/notifier.env
chmod 600 /etc/pm2-notifier/notifier.env
```

Edit `/etc/pm2-notifier/notifier.env` and replace the placeholder with the complete URL from your Teams workflow. The shipped configuration enables only `teams-primary`, so this is the only required entry:

```dotenv
TEAMS_PRIMARY_WEBHOOK_URL="https://replace-with-your-workflow-webhook-url"
```

Keep the full URL, including any query parameters. You do not need a separate Teams token or channel ID; the workflow determines the channel. [Create a Teams Workflows webhook](docs/operations.md#microsoft-teams) if you do not have its URL yet.

Add these entries only when you enable the corresponding destination in `/etc/pm2-notifier/config.json`:

```dotenv
TEAMS_SECONDARY_WEBHOOK_URL="https://replace-with-your-second-teams-workflow-url"
SLACK_OPERATIONS_WEBHOOK_URL="https://replace-with-your-slack-incoming-webhook-url"
DISCORD_OPERATIONS_WEBHOOK_URL="https://replace-with-your-discord-webhook-url"
INCIDENT_WEBHOOK_URL="https://replace-with-your-incident-endpoint-url"
INCIDENT_WEBHOOK_AUTHORIZATION="Bearer replace-with-your-incident-token"
```

| Destination in `config.json` | Required env entries when enabled | Value to supply |
| --- | --- | --- |
| `teams-primary` | `TEAMS_PRIMARY_WEBHOOK_URL` | Complete Teams Workflows webhook URL for the primary channel. Enabled by default. |
| `teams-secondary` | `TEAMS_SECONDARY_WEBHOOK_URL` | Complete webhook URL for the second Teams workflow/channel. |
| `slack-operations` | `SLACK_OPERATIONS_WEBHOOK_URL` | Complete Slack incoming-webhook URL for the target channel. |
| `discord-operations` | `DISCORD_OPERATIONS_WEBHOOK_URL` | Complete Discord webhook URL for the target channel. |
| `incident-webhook` | `INCIDENT_WEBHOOK_URL`, `INCIDENT_WEBHOOK_AUTHORIZATION` | Receiver URL and complete authorization header, including its scheme such as `Bearer`. |

The additional destinations are disabled in the example. Set their `enabled` field to `true` and use their IDs in `routes` to send alerts to them. Adding an env entry alone does not enable a destination. If your incident receiver needs no authorization, remove `Authorization` from that destination's `headersEnv` and omit `INCIDENT_WEBHOOK_AUTHORIZATION`.

The names above match `urlEnv` and `headersEnv` in the shipped JSON. Use the names from your JSON if you add custom destinations. Keep CPU thresholds, alert environment labels, routes, and provider enablement in `config.json`.

Use one `NAME="value"` per line. Values are literal: `${OTHER_VARIABLE}` and shell commands are not expanded. The `pm2 set` commands below supply the file paths, so `NOTIFIER_CONFIG` and `NOTIFIER_ENV_FILE` are unnecessary in this env file. Restart the module after later edits with `pm2 restart @thechandanbhagat/pm2-notifier`; existing PM2 process environment values take precedence over the file.

### 3. Validate and test

Validate the files, then send a real test notification to your Teams channel:

```bash
node "$NOTIFIER_PACKAGE_DIR/dist/cli.js" validate --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env
node "$NOTIFIER_PACKAGE_DIR/dist/cli.js" test --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env --destination teams-primary
```

If you changed providers, replace `teams-primary` with your enabled destination ID.

### 4. Start monitoring

Set `envFile` before `configPath` so credentials are available when monitoring starts:

```bash
pm2 set @thechandanbhagat/pm2-notifier:envFile /etc/pm2-notifier/notifier.env
pm2 set @thechandanbhagat/pm2-notifier:configPath /etc/pm2-notifier/config.json
pm2 logs @thechandanbhagat/pm2-notifier --lines 50
```

Each `pm2 set` restarts the module. Check the logs for `Notifier monitoring started`.

PM2 installs the module under `PM2_HOME/modules`. Keep the configuration and env files in place, and follow the [startup instructions](docs/operations.md#enable-startup-after-reboot) to restore monitoring after reboot.

## Alerts

| Event | Default behavior |
| --- | --- |
| `cpu.high` | Critical alert after sampled CPU remains at least 95% for 60 seconds; process and host CPU are monitored. |
| `cpu.recovered` | Info alert after CPU remains at or below 80% for 15 seconds. |
| `process.restarted` | Info alert when PM2 restart/generation changes are observed. |
| `process.stopped` | Warning after a stop remains unresolved through the 3-second settlement window. |
| `process.errored` | Critical alert when PM2 reports an errored process. |
| `process.deleted` | Warning when a monitored process is deleted from PM2. |
| `process.started` | Optional info alert; disabled by default. |
| `notifier.test` | Info alert sent explicitly by the test CLI. |

To require 100% CPU for one minute, set `monitor.cpu.threshold` to `100` and keep `durationMs` at `60000`. Process CPU is relative to one logical core; host CPU averages across all logical cores. Monitoring is sampled, so brief activity between samples is invisible.

PM2 supplies process status and sometimes an exit code. Notifications include those facts and explicitly report an unknown reason when evidence is absent. Application logs are not forwarded. PM2 `online` status does not prove application readiness, and a stopped server cannot report its own outage.

## Multiple channels and custom webhooks

Create one named destination per channel/webhook URL, even when several belong to the same provider. Routes select events, process names, severities, and process/host scope. Matching routes fan out to enabled destinations and deduplicate repeated destination IDs.

- [Configuration reference](docs/configuration.md): complete options, routing, environment variables, and generic JSON templates.
- [Operations guide](docs/operations.md): create provider webhooks, apply changes, enable reboot startup, and diagnose missed alerts.
- [Architecture and delivery guarantees](docs/architecture.md): monitoring semantics, reasons, retry behavior, and limits.

Generic destinations support HTTPS POST, custom JSON bodies, and static headers read from environment variables. Endpoints that require request signing, OAuth token refresh, a different HTTP method, or a non-JSON body need an adapter service.

### Route application groups to channel groups

Use the [channel-group sample JSON](examples/channel-groups.config.json) as the contents of `/etc/pm2-notifier/config.json`:

| Process group | Channels receiving its alerts |
| --- | --- |
| `payments-*`, such as `payments-api` and `payments-worker` | Primary Teams channel and Slack operations channel. |
| `orders-*`, such as `orders-api` and `orders-worker` | Secondary Teams channel and Discord operations channel. |
| Host CPU high/recovery | Incident webhook. |

Every destination in this sample is enabled, so provide all six env entries listed in [Configure your webhook](#2-configure-your-webhook). Keep webhook URLs in the env file; the JSON uses their variable names.

Each route's `destinations` array is its channel group. Change `processes` to your app names or prefixes, and change `destinations` to the channel IDs you want. All matching routes contribute destinations, so replace the default catch-all routes rather than appending these routes beneath them. Unmatched process alerts are not delivered; a destination matched by several routes receives the alert once.

Version `0.1.0` matches process names. PM2's actual `namespace` field is not supported as a route filter. If your apps have namespace labels but no shared name prefix, list their process names explicitly in `processes`; equal names in different namespaces cannot be distinguished by this release.

After editing the JSON, run the validation command from the quick start, test each channel with `--destination <id>`, and restart the module.

## Development

```bash
git clone https://github.com/thechandanbhagat/pm2-notifier.git
cd pm2-notifier
npm ci
npm run check
npm test
npm run build
```

On Linux or WSL Linux, run the real PM2 smoke test:

```bash
npm run test:integration
```

It installs the scoped module from a loopback npm registry in an isolated temporary PM2 home, sends alerts to a local receiver, and cleans up its fixture processes and files. The test refuses to run on Windows because PM2 uses shared named pipes there.

For temporary local module development, `pm2 install .` runs the checkout with file watching. PM2's local-directory installation does not register the module for daemon startup, and `pm2 save` excludes modules. Use the npm installation above for a server that must recover after reboot.

The module is written in TypeScript. Update tests and these documents when behavior or configuration changes. Provider tests use local fixtures; verify your actual webhook using the CLI before relying on production notifications.

Maintainers can publish tagged versions through GitHub Actions using the [release guide](docs/releases.md).

## License

[MIT](LICENSE).
