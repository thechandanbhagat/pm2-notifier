# Changelog

## 0.2.0 — 2026-10-27

- Default the setup UI to dark mode, with a persistent light-mode toggle and README screenshots of both themes.
- Add a local setup UI on port 3100 for notification channels, alert workflows, monitoring settings, and explicit channel tests.
- Start the UI automatically for PM2 modules without a manual configuration path; preserve existing JSON/env-file deployments.
- Save managed settings and credentials privately outside the installed package and apply changes without restarting the module.
- Add `pm2-notifier ui` and `npm run ui`, with configurable port and managed state path.
- Fix PM2 event-bus cleanup and wait for disconnect completion so applying workflows can safely reconnect the monitor.
- Route process alerts by PM2 namespace with `namespaces` and `excludeNamespaces` filters.
- Preserve namespaces in CPU and lifecycle alerts, including applications sharing a process name.
- Include configuration examples for namespace and process-name groups sent to multiple channels.
- Retain existing process-name routes and send host alerts through separate routes when desired.
- Update Zod and bundled follow-redirects to patched versions for collection validation and credential handling.

## 0.1.0 — 2026-10-13

Initial release.

- Monitor sustained process and host CPU usage with recovery notifications.
- Report PM2 restart, stop, error, deletion, and optional startup events.
- Route alerts to Teams, Slack, Discord, and generic JSON webhooks.
- Batch Teams notifications and retry transient delivery failures with bounded queues.
- Validate configuration and send test notifications through the CLI.

### Known dependency advisory

PM2's file-watching dependency `braces` 3.0.3 has an [upstream stack-exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) with no patched release. File watching is disabled for this module (`watch: false`).
