import { loadEnvFile } from 'node:process';
import { initModule } from 'pmx';
import { loadConfig } from './config';
import { startRuntime } from './runtime';
import { parseUiEnabled, parseUiPort, startUiApplication, withShutdownHandlers } from './application';
import type { Logger } from './types';

const logger: Logger = (level, message, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields })}\n`);
};

initModule({ alert_enabled: false }, (_error, moduleConfig) => {
  const start = async () => {
    if (_error) throw new Error('PM2 module initialization failed');
    const envFile = process.env.NOTIFIER_ENV_FILE || moduleConfig.envFile;
    if (typeof envFile === 'string' && envFile) {
      try { loadEnvFile(envFile); } catch { throw new Error('Cannot load notifier environment file'); }
    }
    const configPath = process.env.NOTIFIER_CONFIG || moduleConfig.configPath;
    if (typeof configPath !== 'string' || !configPath) {
      const application = await startUiApplication({
        port: parseUiPort(moduleConfig.uiPort ?? 3100),
        statePath: typeof moduleConfig.statePath === 'string' ? moduleConfig.statePath : undefined,
        uiEnabled: parseUiEnabled(moduleConfig.uiEnabled ?? true),
      }, logger);
      withShutdownHandlers(application, logger, true);
      return;
    }
    const runtime = await startRuntime(loadConfig(configPath), logger);
    withShutdownHandlers(runtime, logger, true);
  };
  void start().catch(error => {
    logger('error', error instanceof Error ? error.message : 'Notifier startup failed');
    process.exit(1);
  });
});
