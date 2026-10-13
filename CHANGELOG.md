# Changelog

## 0.1.0 — 2026-10-13

Initial release.

- Monitor sustained process and host CPU usage with recovery notifications.
- Report PM2 restart, stop, error, deletion, and optional startup events.
- Route alerts to Teams, Slack, Discord, and generic JSON webhooks.
- Batch Teams notifications and retry transient delivery failures with bounded queues.
- Validate configuration and send test notifications through the CLI.

### Known dependency advisory

PM2's file-watching dependency `braces` 3.0.3 has an [upstream stack-exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) with no patched release. File watching is disabled for this module (`watch: false`).
