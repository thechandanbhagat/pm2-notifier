# Operations guide

How to configure and operate the notifier on a Linux server running PM2.

**Owner:** Project maintainers · **Last reviewed:** 2026-10-13 · **Review by:** 2027-01-13 or a provider setup change.

## Create webhook destinations

Create a separate webhook for every destination channel, then give each an ID in `destinations`. Store URLs and authorization values only in `/etc/pm2-notifier/notifier.env`. Use the matching ID in `routes`.

### Microsoft Teams

1. In the destination channel, open **Workflows** and create a workflow that posts to the channel when it receives a webhook request. Microsoft also documents creating this through Power Automate with the **When a Teams webhook request is received** trigger.
2. Select the target team/channel and complete the workflow connection. For URL-only delivery, use the trigger's **Anyone** authentication option if your tenant permits it. The module does not acquire or refresh Microsoft Entra access tokens.
3. Copy the generated webhook URL into `TEAMS_PRIMARY_WEBHOOK_URL` in the protected env file. Set the destination's format to `teams`.
4. Send the CLI test and check both the Teams channel and the workflow run history. Add another owner to the workflow so its operation does not depend on one person's account.

The built-in formatter posts a `type: "message"` envelope containing an `application/vnd.microsoft.card.adaptive` attachment. A custom workflow must accept this envelope and post its Adaptive Card content. Use a current Workflows endpoint; the module's Teams format is not a legacy MessageCard payload. Follow [Microsoft's webhook and Workflows setup guide](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook).

#### Workflow template attribution

The “used a Workflow template to send this card” attribution and “Get template” link come from Teams, outside the Adaptive Card JSON. Removing card actions does not remove that attribution.

Users have [reported a Save as workaround on Microsoft Q&A](https://learn.microsoft.com/en-sg/answers/questions/1825917/how-to-avoid-getting-a-text-like-xyz-used-a-workfl), with mixed results:

1. In Power Automate, open **My flows**, select the template-based webhook flow, and choose **Save as** with a new name.
2. Open the copied flow and **Turn on** it. Confirm its Teams connection and target channel.
3. Copy the new trigger URL into the destination's webhook environment variable in the protected env file. The original URL still invokes the template flow.
4. Run the notifier CLI test against the new URL and check the posted card. Restart the notifier after updating the server env file.

This requires editing the Power Automate flow; it cannot be done by sending a different notifier payload. Keep the original flow until the new one has been tested. If copying retains the attribution, build a fresh custom flow using **When a Teams webhook request is received**, iterate over the received `attachments`, and post each attachment's `content` as an Adaptive Card to the target channel. Verify that flow's output before switching production delivery.

### Slack

Create or select a Slack app, enable Incoming Webhooks, and choose **Add New Webhook to Workspace**. Authorize the destination channel and store the resulting URL under `SLACK_OPERATIONS_WEBHOOK_URL`. Enable its `slack` destination in the JSON configuration.

An incoming-webhook URL is tied to its authorized channel/workspace. Create separate webhooks and destination IDs for other channels; this module does not override the channel in the payload. See [Slack's incoming webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).

### Discord

In the destination server/channel integrations, create a webhook and copy its URL. Store it under `DISCORD_OPERATIONS_WEBHOOK_URL`, enable the corresponding `discord` destination, and test it. Create another webhook for another channel. The formatter disables automatic mentions. See the [Discord webhook API](https://docs.discord.com/developers/resources/webhook).

### Generic webhook

Create a `generic` destination with its own `urlEnv`. Omit `template` to receive the complete alert JSON, or map fields with [template tokens](configuration.md#generic-json-templates). If the endpoint needs a static authorization header, reference an env variable through `headersEnv`:

```dotenv
INCIDENT_WEBHOOK_URL="https://your-receiver.example/alerts"
INCIDENT_WEBHOOK_AUTHORIZATION="Bearer replace-with-your-token"
```

The receiver must accept JSON POST requests. Custom request signatures, automatic OAuth refresh, non-JSON bodies, and other HTTP methods require an adapter. A generic receiver can deduplicate retries by alert `id`; include `{{id}}` when using a custom template.

## Add channels or change routing

1. Add the new URL variable to the protected env file.
2. Add or enable the destination in the JSON configuration and reference it from a route.
3. Validate, send a direct test to that destination, then restart the notifier:

```bash
NOTIFIER_PACKAGE_DIR="${PM2_HOME:-$HOME/.pm2}/modules/@thechandanbhagat/pm2-notifier/node_modules/@thechandanbhagat/pm2-notifier"
node "$NOTIFIER_PACKAGE_DIR/dist/cli.js" validate --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env
node "$NOTIFIER_PACKAGE_DIR/dist/cli.js" test --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env --destination slack-operations
pm2 restart @thechandanbhagat/pm2-notifier
pm2 logs @thechandanbhagat/pm2-notifier --lines 50
```

A direct test bypasses route filters. To test routing as well, run the command without `--destination`; it sends `notifier.test`, severity `info`, with host scope to matching enabled destinations. Neither test simulates CPU saturation or process failures.

JSON/env files are read at startup. `pm2 set` changes module settings and restarts it automatically; editing a referenced file needs an explicit restart. The notifier does not restart or stop applications in response to alerts.

## Enable startup after reboot

Install the npm package with `pm2 install @thechandanbhagat/pm2-notifier` as described in the [quick start](../README.md#quick-start). This registers the module under `PM2_HOME/modules` so PM2 can start it when its daemon starts. The local-development command `pm2 install .` does not register it this way.

Run PM2 commands as the application owner with the same `PM2_HOME`. If PM2 startup is not already configured:

```bash
pm2 startup
```

Run the exact privileged command printed by PM2, then save the intended application process list:

```bash
pm2 save
```

`pm2 save` saves applications; PM2 restores registered modules separately. Confirm after a planned reboot that the applications and module appear in `pm2 list`, and that notifier logs contain `Notifier monitoring started`. The installed package under `PM2_HOME/modules`, configuration, and env file must still exist and be readable. The source checkout is not needed for module startup. See the [PM2 module documentation](https://pm2.keymetrics.io/docs/advanced/pm2-module-system/) for module installation and configuration.

## Upgrade the installed module

When upgrading from a previous module name, stop that module before installing `@thechandanbhagat/pm2-notifier` and set `envFile` and `configPath` again under the new name to avoid duplicate alerts. After verifying delivery from the new module, uninstall the previous module so it cannot return after a daemon restart.

Review the [release notes](https://github.com/thechandanbhagat/pm2-notifier/releases), then validate your existing configuration with the installed CLI:

```bash
NOTIFIER_PACKAGE_DIR="${PM2_HOME:-$HOME/.pm2}/modules/@thechandanbhagat/pm2-notifier/node_modules/@thechandanbhagat/pm2-notifier"
node "$NOTIFIER_PACKAGE_DIR/dist/cli.js" validate --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env
```

Install the latest published version and apply the external file settings:

```bash
pm2 install @thechandanbhagat/pm2-notifier
pm2 set @thechandanbhagat/pm2-notifier:envFile /etc/pm2-notifier/notifier.env
pm2 set @thechandanbhagat/pm2-notifier:configPath /etc/pm2-notifier/config.json
pm2 logs @thechandanbhagat/pm2-notifier --lines 50
node "$NOTIFIER_PACKAGE_DIR/dist/cli.js" validate --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env
node "$NOTIFIER_PACKAGE_DIR/dist/cli.js" test --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env --destination teams-primary
```

Replace `teams-primary` with an enabled destination ID if you use another provider. The JSON and env files stay outside the package. Reinstallation restarts the module, resetting CPU/lifecycle observation state; in-memory queued alerts can be lost during restart. Confirm `Notifier monitoring started` and check that the CLI test reached the receiver.

## Investigate a CPU alert

Read the alert's host, process name/PM2 ID, measured CPU, and configured threshold. A process alert describes one PM2 instance; a host alert describes aggregate CPU. A single busy core can produce a process alert without a host alert on a multicore server.

```bash
pm2 list
pm2 describe APP_NAME
pm2 monit
pm2 logs APP_NAME --lines 100
```

Compare with OS CPU observations and recent deployments. Choose mitigation based on the application's runbook. The notifier observes and reports; it never kills a process to reduce CPU. One high alert remains active until sustained recovery, so continuing high CPU does not produce reminders. A missing recovery alert may mean CPU has not met the recovery duration, its route excludes recovery events, or notifier/process state was reset by a restart.

## Investigate a stop or restart

Inspect `status`, `restarts`, `exitCode`, and `reason` in the message. Use the process commands above and application/OS logs to find the underlying cause. PM2 cannot reliably distinguish manual operations, crashes, OOM kills, deployment restarts, and all signals from the available notification data. An exit code is evidence of how a process ended, not proof of why it ended.

The settlement window combines a stop followed promptly by a return online into a restart alert. If the stop persists beyond that window, a stop/error alert can be followed by a later restart alert. PM2 `online` is process status; use application health checks to verify readiness.

## Troubleshoot missing notifications

| Symptom | Check and next step |
| --- | --- |
| Module says `Notifier is idle` | Set `@thechandanbhagat/pm2-notifier:envFile`, then `@thechandanbhagat/pm2-notifier:configPath`, to absolute readable paths. |
| Module repeatedly exits at startup | Run `validate` with the same files and account. Fix invalid JSON, unknown fields, missing env variables, or inaccessible files. |
| Module disappears after daemon restart/reboot | Run `pm2 install @thechandanbhagat/pm2-notifier`. Local-directory `pm2 install .` uses file watching and does not register a persistent module; `pm2 save` does not save modules. |
| CLI works but module has missing credentials | Confirm PM2 module `envFile` is set and readable. Existing daemon environment can override the file; shell exports alone do not reconfigure a running daemon. |
| Monitoring starts but an application is absent | Check the PM2 OS account and `PM2_HOME`; inspect global include/exclude patterns. PM2 modules are excluded by default. |
| `Alert generated` appears but no delivery happens | Check event, severity, process filters, scope, enabled destinations, and route IDs. An unmatched alert is not sent. |
| CPU briefly hits 100% without an alert | It must remain above the threshold across observations for the full configured duration. Invalid/missed observations reset continuity; process and host percentages differ. |
| No initial process-start alerts | `notifyOnStart` defaults to false to avoid startup noise. |
| Test reports no matching destination | Add a route allowing `notifier.test`/info/host, or use `--destination` with an enabled destination ID. |
| HTTP 400 or other nonretryable rejection | Check the selected format, endpoint type, workflow schema, and provider permissions. Response bodies are not logged. |
| HTTP 401/403 | Check the URL/token and provider authentication mode. The module does not refresh OAuth credentials. |
| HTTP 404/410 | The webhook may have been removed or replaced; update its env variable and restart. |
| HTTP 429 or repeated 5xx/timeouts | Check provider status, network connectivity, and outbound HTTPS access. Backoff is bounded and queues are finite. |
| Redirect response | Configure the final webhook URL; redirects are rejected. |
| Provider accepts test but channel stays empty | Check downstream workflow execution and its channel/action permissions. Endpoint acceptance is not channel delivery confirmation. |
| Queue overflow or delivery-failed log | Newest arrivals are dropped when full; exhausted attempts are not persisted. Reduce alert volume, fix receiver availability, or use a durable relay. |
| No alerts during host failure | A local module cannot notify while its server is offline. Use an external availability monitor. |

Logs contain JSON records with sanitized status and delivery metadata. They do not include webhook URLs, headers, provider response bodies, or application log content. Treat process names, host labels, and timestamps as operational information when sharing logs.
