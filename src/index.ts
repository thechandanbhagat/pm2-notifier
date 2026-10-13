import { loadEnvFile } from 'node:process';
import { initModule } from 'pmx';
import { loadConfig } from './config';
import { startRuntime } from './runtime';
import type { Logger } from './types';

const IDLE_INTERVAL_MS = 60_000;
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
      logger('warn', 'Notifier is idle: set @thechandanbhagat/pm2-notifier:configPath and envFile, or NOTIFIER_CONFIG and NOTIFIER_ENV_FILE');
      setInterval(() => logger('warn', 'Notifier is idle: configuration path is required'), IDLE_INTERVAL_MS);
      return;
    }
    const runtime = await startRuntime(loadConfig(configPath), logger);
    let shuttingDown = false;
    const stop = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try { await runtime.stop(); process.exit(0); }
      catch { logger('error', 'Notifier shutdown failed; undelivered alerts may be lost'); process.exit(1); }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.on('message', message => { if (message === 'shutdown') void stop(); });
  };
  void start().catch(error => {
    logger('error', error instanceof Error ? error.message : 'Notifier startup failed');
    process.exit(1);
  });
});
