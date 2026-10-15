#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { loadConfig } from './config';
import { createDispatcher, routeDestinations } from './delivery';
import { parseUiPort, startUiApplication, withShutdownHandlers, type Application } from './application';
import type { Alert, Config, Logger } from './types';

const HELP = 'Usage: pm2-notifier ui [--port 3100] [--state-file <file>] [--config <file>] [--env-file <file>]\n       pm2-notifier <validate|test> --config <file> [--env-file <file>] [--destination <id>]\nThe UI creates channels and workflows and runs monitoring. Open the private URL printed at startup.\nThe test command sends a real notifier.test notification to matching destinations.\n';

export async function runCli(args: string[], logger: Logger): Promise<Application | void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, 'env-file': { type: 'string' }, destination: { type: 'string' }, help: { type: 'boolean' },
    port: { type: 'string' }, 'state-file': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['validate', 'test', 'ui'].includes(command)) throw new Error(HELP.trim());
  if (values.destination && command !== 'test') throw new Error('--destination is only supported by test');
  if (command !== 'ui' && (values.port !== undefined || values['state-file'] !== undefined)) throw new Error('--port and --state-file are only supported by ui');
  if (command === 'ui') {
    const configPath = values.config || process.env.NOTIFIER_CONFIG;
    const envFile = values['env-file'] || process.env.NOTIFIER_ENV_FILE;
    if (envFile && !configPath) throw new Error('--env-file requires --config when importing into the UI');
    const application = await startUiApplication({
      port: parseUiPort(values.port ?? 3100), statePath: values['state-file'], configPath, envFile,
    }, logger);
    return withShutdownHandlers(application, logger);
  }
  const envFile = values['env-file'] || process.env.NOTIFIER_ENV_FILE;
  if (envFile) {
    try { loadEnvFile(envFile); } catch { throw new Error('Cannot load notifier environment file'); }
  }
  const path = values.config || process.env.NOTIFIER_CONFIG;
  if (!path) throw new Error('--config or NOTIFIER_CONFIG is required');
  const config = loadConfig(path);
  if (command === 'validate') {
    logger('info', 'Configuration valid', { destinations: config.destinations.filter(destination => destination.enabled).length, routes: config.routes.length });
    return;
  }
  const alert: Alert = {
    id: randomUUID(), type: 'notifier.test', severity: 'info', timestamp: new Date().toISOString(),
    hostname: config.hostname, environment: config.environment,
    message: 'PM2 notifier test: webhook delivery is configured.', details: { scope: 'host' },
  };
  let deliveryConfig: Config = config;
  if (values.destination) {
    const target = config.destinations.find(destination => destination.id === values.destination && destination.enabled);
    if (!target) throw new Error('Requested destination does not exist or is disabled');
    deliveryConfig = { ...config, routes: [{ destinations: [target.id], events: ['*'], processes: ['*'], excludeProcesses: [], severities: ['info', 'warning', 'critical'], scope: 'all' }] };
  }
  if (!routeDestinations(deliveryConfig, alert).length) throw new Error('No enabled destination matches notifier.test; use --destination to test a specific destination');
  const dispatcher = createDispatcher(deliveryConfig, logger);
  dispatcher.enqueue(alert);
  await dispatcher.close();
  logger('info', 'Test notification accepted by webhook endpoint(s)');
}

if (require.main === module) {
  const logger: Logger = (level, message, fields = {}) => process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields })}\n`);
  void runCli(process.argv.slice(2), logger).catch(error => {
    logger('error', error instanceof Error ? error.message : 'Command failed');
    process.exitCode = 1;
  });
}
