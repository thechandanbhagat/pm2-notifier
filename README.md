# PM2 webhook notifier

A PM2 module for server operators that sends sustained CPU, restart, stop, and crash alerts to any combination of Teams, Slack, Discord, and JSON webhooks.

**Owner:** Project maintainers · **Last reviewed:** 2026-09-14 · **Review by:** 2026-12-14 or the next release.

## Quick start

Use Node.js 22 or newer and the same OS account and `PM2_HOME` as the applications you monitor. Build a package from the checkout and install that package with PM2; no npm publication is required. The package and PM2 module name is `pm2-notifier`.

From that checkout:

```bash
npm ci
npm run build
mkdir -p excluded
npm pack --pack-destination excluded
sudo install -d -m 750 -o "$(id -un)" -g "$(id -gn)" /etc/pm2-notifier
install -m 600 examples/notifier.config.json /etc/pm2-notifier/config.json
touch /etc/pm2-notifier/notifier.env
chmod 600 /etc/pm2-notifier/notifier.env
```

Edit `/etc/pm2-notifier/notifier.env` using your editor and add your actual Teams Workflows webhook URL:

```dotenv
TEAMS_PRIMARY_WEBHOOK_URL="https://replace-with-your-workflow-webhook-url"
```

The example enables one Teams destination. Other destinations stay disabled until you supply their credentials and enable them. Validate locally, then send a real test message:

```bash
node dist/cli.js validate --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env
node dist/cli.js test --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env --destination teams-primary
```

Install and configure the module using the PM2 executable that manages your applications:

```bash
pm2 install "$(pwd)/excluded/pm2-notifier-0.1.0.tgz"
pm2 set pm2-notifier:envFile /etc/pm2-notifier/notifier.env
pm2 set pm2-notifier:configPath /etc/pm2-notifier/config.json
pm2 logs pm2-notifier --lines 50
```

Expect `Notifier monitoring started` in the logs. Before a configuration path is set, the module starts idle and logs that it needs configuration. Set `envFile` first and `configPath` last so credentials are available when monitoring starts. Each `pm2 set` restarts the module.

The archive contains the built module and its production dependencies. Passing the `.tgz` path to `pm2 install` registers a persistent module under `PM2_HOME/modules`; runtime files no longer depend on the checkout. Keep the checkout for the CLI commands above, or use the installed package's CLI. Keep the configuration and env files available, and follow the [reboot startup instructions](docs/operations.md#enable-startup-after-reboot).

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
