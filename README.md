# pm2-notifier

A PM2 module for server operators that sends sustained CPU, restart, stop, and crash alerts to any combination of Teams, Slack, Discord, and JSON webhooks.

**Owner:** Project maintainers · **Last reviewed:** 2026-10-13 · **Review by:** 2027-01-13 or the next release.

## Quick start

These steps target Linux servers with PM2 already managing your applications. You need Node.js 22 or newer, npm, and Git. Run PM2 commands as the same OS user and with the same `PM2_HOME` as those applications.

### 1. Clone and package

```bash
git clone https://github.com/thechandanbhagat/pm2-notifier.git
cd pm2-notifier
npm ci
mkdir -p excluded
npm pack --pack-destination excluded
```

`npm pack` builds the TypeScript code and bundles production dependencies. Version `0.1.0` produces `excluded/pm2-notifier-0.1.0.tgz`; use the filename printed by `npm pack` for other versions.

### 2. Configure your webhook

Keep configuration and credentials outside the checkout:

```bash
sudo install -d -m 750 -o "$(id -un)" -g "$(id -gn)" /etc/pm2-notifier
install -m 600 examples/notifier.config.json /etc/pm2-notifier/config.json
touch /etc/pm2-notifier/notifier.env
chmod 600 /etc/pm2-notifier/notifier.env
```

The example enables the `teams-primary` destination. [Create a Teams Workflows webhook](docs/operations.md#microsoft-teams), then add its URL to `/etc/pm2-notifier/notifier.env`:

```dotenv
TEAMS_PRIMARY_WEBHOOK_URL="https://replace-with-your-workflow-webhook-url"
```

For Slack, Discord, or a custom webhook, update `destinations` and `routes` in `/etc/pm2-notifier/config.json` using the [configuration reference](docs/configuration.md).

### 3. Validate and test

Validate the files, then send a real test notification to your Teams channel:

```bash
node dist/cli.js validate --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env
node dist/cli.js test --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env --destination teams-primary
```

If you changed providers, replace `teams-primary` with your enabled destination ID.

### 4. Install and start

Install the archive and set `envFile` before `configPath` so credentials are available when monitoring starts:

```bash
pm2 install "$(pwd)/excluded/pm2-notifier-0.1.0.tgz"
pm2 set pm2-notifier:envFile /etc/pm2-notifier/notifier.env
pm2 set pm2-notifier:configPath /etc/pm2-notifier/config.json
pm2 logs pm2-notifier --lines 50
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

## Development

```bash
npm ci
npm run check
npm test
npm run build
```

On Linux or WSL Linux, run the real PM2 smoke test:

```bash
npm run test:integration
```

It installs the module in an isolated temporary PM2 home, sends alerts to a local receiver, and cleans up its fixture processes and files. The test refuses to run on Windows because PM2 uses shared named pipes there.

For temporary local module development, `pm2 install .` runs the checkout with file watching. PM2's local-directory installation does not register the module for daemon startup, and `pm2 save` excludes modules. Use the packaged installation above for a server that must recover after reboot.

The module is written in TypeScript. Update tests and these documents when behavior or configuration changes. Provider tests use local fixtures; verify your actual webhook using the CLI before relying on production notifications.
