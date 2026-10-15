# Operations guide

How to configure and operate the notifier on a Linux server running PM2.

**Owner:** Project maintainers · **Last reviewed:** 2026-10-15 · **Review by:** 2027-01-15 or a provider setup change.

## Open and operate the UI

A fresh module installation opens a local HTTP listener at `127.0.0.1:3100`. Read `pm2 logs @thechandanbhagat/pm2-notifier --lines 50` and open the complete logged URL, including `#token=…`. This token grants access to settings and test delivery, changes on restart, and should stay private. Stored webhook credentials are never displayed again; an empty credential field retains the current value.

For a remote PM2 server, keep an SSH tunnel open from your computer:

```bash
ssh -L 3100:127.0.0.1:3100 user@server
```

Open the logged URL in your computer's browser. The UI is loopback-only and has no public-listen option. To change its port, set `uiPort` and read the new access URL:

```bash
pm2 set @thechandanbhagat/pm2-notifier:uiPort 3200
pm2 logs @thechandanbhagat/pm2-notifier --lines 50
```

PM2 saves this setting and automatically restarts the module; no extra restart is necessary. The UI moves to `127.0.0.1:3200`, and its access token changes. Open the fresh complete URL from the logs. Saved workflows and notification channels persist. For remote access, update the tunnel to `ssh -L 3200:127.0.0.1:3200 user@server`.

For a manual restart at another time, run `pm2 restart @thechandanbhagat/pm2-notifier`, then read the logs for the fresh access URL. See [Change the UI port](../README.md#change-the-ui-port) for the full command sequence.

Create channels, assign them to workflows, and select **Save and apply**. Use **Test channel** on a saved channel to send a real notification; tests are unavailable while you have unsaved changes. A successful test means the provider accepted the request; also check the target channel. Saves reinitialize monitoring, resetting CPU durations and lifecycle baselines. Existing applications continue to run.

UI channel tests make one delivery attempt with a timeout of at most five seconds. Normal alerts continue to use the configured delivery timeout and retries.

The default managed file is `${PM2_HOME:-$HOME/.pm2}/pm2-notifier/ui-settings.json`; it contains webhook credentials and uses mode `600`. Back it up securely. Configure a custom location with the module's `statePath` setting. To keep monitoring saved settings with no UI listener:

```bash
pm2 set @thechandanbhagat/pm2-notifier:uiEnabled false
```

Set it back to `true` to edit settings again. Without a saved configuration, disabling the UI leaves the notifier idle.

Existing deployments that set `configPath` or `NOTIFIER_CONFIG` stay in manual file mode. For standalone use, `pm2-notifier ui --port 3100` serves the UI and runs monitoring until Ctrl+C. Its `--config` and `--env-file` options import existing settings into an unused managed `--state-file` and start monitoring immediately; later UI saves update that managed file. Stop the installed notifier before running a standalone monitor against the same PM2 daemon, since both instances would send alerts.

## Move an existing file setup into the UI

1. Stop the installed notifier with `pm2 stop @thechandanbhagat/pm2-notifier` to avoid duplicate alerts during import.
2. Start its UI with your existing files:

   ```bash
   NOTIFIER_PACKAGE_DIR="${PM2_HOME:-$HOME/.pm2}/modules/@thechandanbhagat/pm2-notifier/node_modules/@thechandanbhagat/pm2-notifier"
   node "$NOTIFIER_PACKAGE_DIR/dist/cli.js" ui --config /etc/pm2-notifier/config.json --env-file /etc/pm2-notifier/notifier.env
   ```

3. Open the logged link, review the imported channels and workflows, and save any changes. Import stores settings immediately and starts monitoring. The original JSON/env files are preserved. If managed settings already exist, omit `--config` and `--env-file` to reopen them; imports do not overwrite an existing managed file.
4. Stop the standalone UI with Ctrl+C. Clear the module's `configPath` and `envFile` settings, then restart it to use managed settings:

   ```bash
   pm2 unset @thechandanbhagat/pm2-notifier:configPath
   pm2 unset @thechandanbhagat/pm2-notifier:envFile
   pm2 restart @thechandanbhagat/pm2-notifier
   pm2 logs @thechandanbhagat/pm2-notifier --lines 50
   ```

Use the same PM2 account and `PM2_HOME` throughout. If you supplied `--state-file`, set the module's `statePath` to the same path. Remove any overriding `NOTIFIER_CONFIG` or `NOTIFIER_ENV_FILE` from the module's process environment as well; they take precedence over module settings. Confirm `Notifier monitoring started` before relying on the migrated setup.

## Create webhook destinations

Create a separate webhook for every destination channel, then add its URL in the UI and assign the channel to a workflow. A notifier workflow routes alerts; provider-side setup still determines the real Teams, Slack, or Discord channel. For manual file mode, give each webhook an ID in `destinations`, store its URL and authorization values in the protected env file, and use the ID in `routes`.

### Microsoft Teams

1. In the destination channel, open **Workflows** and create a workflow that posts to the channel when it receives a webhook request. Microsoft also documents creating this through Power Automate with the **When a Teams webhook request is received** trigger.
2. Select the target team/channel and complete the workflow connection. For URL-only delivery, use the trigger's **Anyone** authentication option if your tenant permits it. The module does not acquire or refresh Microsoft Entra access tokens.
3. Add a Teams channel in the notifier UI and paste the generated URL. In manual mode, set `TEAMS_PRIMARY_WEBHOOK_URL` in the protected env file and use destination format `teams`.
4. Send a test from the UI or CLI and check both the Teams channel and the workflow run history. Add another owner to the workflow so its operation does not depend on one person's account.

The built-in formatter posts a `type: "message"` envelope containing an `application/vnd.microsoft.card.adaptive` attachment. A custom workflow must accept this envelope and post its Adaptive Card content. Use a current Workflows endpoint; the module's Teams format is not a legacy MessageCard payload. Follow [Microsoft's webhook and Workflows setup guide](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook).

#### Workflow template attribution

The “used a Workflow template to send this card” attribution and “Get template” link come from Teams, outside the Adaptive Card JSON. Removing card actions does not remove that attribution.

Users have [reported a Save as workaround on Microsoft Q&A](https://learn.microsoft.com/en-sg/answers/questions/1825917/how-to-avoid-getting-a-text-like-xyz-used-a-workfl), with mixed results:

1. In Power Automate, open **My flows**, select the template-based webhook flow, and choose **Save as** with a new name.
2. Open the copied flow and **Turn on** it. Confirm its Teams connection and target channel.
3. Replace the channel's URL in the UI and save, or update its webhook environment variable in the protected env file. The original URL still invokes the template flow.
4. Send a test against the new URL and check the posted card. Manual env-file edits require a notifier restart.

This requires editing the Power Automate flow; it cannot be done by sending a different notifier payload. Keep the original flow until the new one has been tested. If copying retains the attribution, build a fresh custom flow using **When a Teams webhook request is received**, iterate over the received `attachments`, and post each attachment's `content` as an Adaptive Card to the target channel. Verify that flow's output before switching production delivery.

### Slack

Create or select a Slack app, enable Incoming Webhooks, and choose **Add New Webhook to Workspace**. Authorize the destination channel and paste the resulting URL into a Slack channel in the notifier UI. In manual mode, store it under `SLACK_OPERATIONS_WEBHOOK_URL` and enable its `slack` destination in the JSON configuration.

An incoming-webhook URL is tied to its authorized channel/workspace. Create separate webhooks and destination IDs for other channels; this module does not override the channel in the payload. See [Slack's incoming webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).

### Discord

In the destination server/channel integrations, create a webhook and copy its URL. Paste it into a Discord channel in the notifier UI, save, and test it. In manual mode, store it under `DISCORD_OPERATIONS_WEBHOOK_URL` and enable the corresponding `discord` destination. Create another webhook for another channel. The formatter disables automatic mentions. See the [Discord webhook API](https://docs.discord.com/developers/resources/webhook).

### Generic webhook

In the UI, add a generic webhook channel and provide its URL and any static headers. In manual mode, create a `generic` destination with its own `urlEnv`. Omit `template` to receive the complete alert JSON, or map fields with [template tokens](configuration.md#generic-json-templates). If the endpoint needs a static authorization header, reference an env variable through `headersEnv`:

```dotenv
INCIDENT_WEBHOOK_URL="https://your-receiver.example/alerts"
INCIDENT_WEBHOOK_AUTHORIZATION="Bearer replace-with-your-token"
```

The receiver must accept JSON POST requests. Custom request signatures, automatic OAuth refresh, non-JSON bodies, and other HTTP methods require an adapter. A generic receiver can deduplicate retries by alert `id`; include `{{id}}` when using a custom template.

## Add channels or change routing

In the UI, add or edit a channel, select it in the relevant workflows, and save. Test the saved channel directly. You can route process-name patterns such as `payments-*` to one channel group and `orders-*` to another.

For manual file mode:

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

`pm2 save` saves applications; PM2 restores registered modules separately. Confirm after a planned reboot that the applications and module appear in `pm2 list`, and that notifier logs contain `Notifier monitoring started`. The installed package under `PM2_HOME/modules` and its managed settings file, or manual configuration and env file, must still exist and be readable. The source checkout is not needed for module startup. See the [PM2 module documentation](https://pm2.keymetrics.io/docs/advanced/pm2-module-system/) for module installation and configuration.

## Upgrade the installed module

When upgrading from a previous module name, stop that module before installing `@thechandanbhagat/pm2-notifier` and set `envFile` and `configPath` again under the new name to avoid duplicate alerts. After verifying delivery from the new module, uninstall the previous module so it cannot return after a daemon restart.

Review the [release notes](https://github.com/thechandanbhagat/pm2-notifier/releases). For managed settings, keep a protected backup of the state file, install the newer module with `pm2 install @thechandanbhagat/pm2-notifier`, and check monitoring and a channel test in the UI. The managed file is outside the package and survives upgrades; obtain the new UI access link from logs after restart.

For manual file mode, validate your existing configuration with the installed CLI:

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
| Module says `Notifier is idle` | Open the logged UI link and save channels and workflows. If UI is disabled, enable `uiEnabled` or supply managed settings. For manual mode, set `envFile`, then `configPath`, to absolute readable paths. |
| UI cannot listen on its port | Check for another notifier or service using the port; set `uiPort` to a free port and update your SSH tunnel. |
| UI reports unauthorized access | Reopen the complete current access URL from the module logs; restarting the UI changes its token. |
| UI cannot read or save managed settings | Check the PM2 account, state path, directory ownership and private permissions; managed settings reject symlink or non-private state files. |
| UI says another settings save is in progress | Retry when the other save finishes. If a crash left a lock behind, stop all notifier UI instances, remove only the `<statePath>.lock` file, then restart. Keep the settings file itself. |
| UI saved settings but monitoring did not start | Read the reported runtime status and module logs, fix PM2 connectivity or settings, and save again. Saved settings are kept even when application fails. |
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
| HTTP 404/410 | The webhook may have been removed or replaced; update and save its URL in the UI, or update its env variable and restart in manual mode. |
| HTTP 429 or repeated 5xx/timeouts | Check provider status, network connectivity, and outbound HTTPS access. Backoff is bounded and queues are finite. |
| Redirect response | Configure the final webhook URL; redirects are rejected. |
| Provider accepts test but channel stays empty | Check downstream workflow execution and its channel/action permissions. Endpoint acceptance is not channel delivery confirmation. |
| Queue overflow or delivery-failed log | Newest arrivals are dropped when full; exhausted attempts are not persisted. Reduce alert volume, fix receiver availability, or use a durable relay. |
| No alerts during host failure | A local module cannot notify while its server is offline. Use an external availability monitor. |

Logs contain JSON records with sanitized status and delivery metadata. They do not include webhook URLs, headers, provider response bodies, or application log content. The UI startup log does contain its private access link; remove that link before sharing logs. Treat process names, host labels, and timestamps as operational information when sharing logs.
