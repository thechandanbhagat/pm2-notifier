import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseConfig, parseRawConfig, type RawConfig } from './config';
import type { Config } from './types';

const MAX_STATE_BYTES = 1_048_576;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EMPTY_REVISION = createHash('sha256').update('unconfigured').digest('hex');

export class WebStateError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

interface StoredSettings {
  readonly config: RawConfig;
  readonly secrets: Record<string, string>;
}

export interface ManagedSnapshot {
  readonly revision: string;
  readonly config: RawConfig | null;
  readonly configuredSecrets: string[];
}

export interface ManagedStore {
  snapshot(): ManagedSnapshot;
  resolvedConfig(): Config | null;
  save(revision: string, config: unknown, secrets: unknown): Promise<Config>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSecrets(input: unknown): Record<string, string> {
  if (!isRecord(input) || Object.entries(input).some(([name, value]) => !ENV_NAME.test(name) || typeof value !== 'string')) {
    throw new WebStateError('Channel credentials must be named text values.');
  }
  return input as Record<string, string>;
}

function referencedSecrets(config: RawConfig, environment: NodeJS.ProcessEnv): Record<string, string> {
  const names = new Set(config.destinations.flatMap(destination => [destination.urlEnv, ...Object.values(destination.headersEnv)]));
  return Object.fromEntries([...names].flatMap(name => {
    const value = Object.hasOwn(environment, name) ? environment[name] : undefined;
    return value?.trim() ? [[name, value]] : [];
  }));
}

function validateSettings(input: unknown, secrets: NodeJS.ProcessEnv): StoredSettings {
  try {
    const config = parseRawConfig(input);
    const selected = referencedSecrets(config, secrets);
    parseConfig(config, selected);
    return { config, secrets: selected };
  } catch (error) {
    // Schema issues can contain attacker-supplied field names. Never echo them or secret values.
    const message = error instanceof Error ? error.message : '';
    const safeMessages = new Set([
      'Destination IDs must be unique',
      'monitor.cpu.recoveryThreshold must be less than threshold',
      'Host CPU threshold cannot exceed 100',
      'delivery.baseDelayMs must not exceed maxDelayMs',
      'Route references an unknown destination ID',
      'Route contains an unsupported event type or pattern',
    ]);
    if (safeMessages.has(message) || /^Required environment variable [A-Za-z_][A-Za-z0-9_]* is missing or empty$/.test(message)) {
      throw new WebStateError(message);
    }
    const destinationIssue = /^Destination [A-Za-z0-9_-]{1,100}: (invalid webhook URL|use HTTPS without URL credentials or fragment; HTTP requires allowInsecureHttp|unsupported header name|invalid header value|template requires generic format)$/.exec(message);
    if (destinationIssue) throw new WebStateError(`Notification channel: ${destinationIssue[1]}.`);
    throw new WebStateError('Configuration is invalid. Check channel credentials, workflow selections, and monitoring settings.');
  }
}

function revisionFor(settings: StoredSettings | null): string {
  return settings === null ? EMPTY_REVISION : createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}

async function ensureDirectory(path: string, create: boolean): Promise<boolean> {
  const parent = dirname(path);
  if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
  let info;
  try { info = await lstat(parent); } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new WebStateError('Managed settings require a private directory owned by the current user (mode 0700).', 500);
  }
  return true;
}

async function readSettings(path: string): Promise<StoredSettings | null> {
  try {
    if (!await ensureDirectory(path, false)) return null;
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let text: string;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_STATE_BYTES || (info.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Unsafe settings file');
      // Bound the read even if a file is changed while open.
      const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_STATE_BYTES) throw new Error('Oversized settings file');
      text = bytes.subarray(0, length).toString('utf8');
    } finally { await file.close(); }
    const data: unknown = JSON.parse(text);
    if (!isRecord(data) || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'config') || !Object.hasOwn(data, 'secrets')) {
      throw new Error('Invalid settings document');
    }
    return validateSettings(data.config, validateSecrets(data.secrets));
  } catch {
    throw new WebStateError('Cannot read managed settings. Use a valid private settings file and directory; symbolic links are not supported.', 500);
  }
}

async function writeSettings(path: string, settings: StoredSettings): Promise<void> {
  const contents = JSON.stringify(settings, null, 2) + '\n';
  if (Buffer.byteLength(contents) > MAX_STATE_BYTES) throw new WebStateError('Managed settings exceed the 1 MiB limit.', 413);
  let temporary: string | undefined;
  try {
    await ensureDirectory(path, true);
    // Check an existing target before replacing it; never follow a link or overwrite an unrelated file.
    await readSettings(path);
    temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally { await file.close(); }
    await ensureDirectory(path, false);
    await readSettings(path);
    await rename(temporary, path);
    temporary = undefined;
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (error instanceof WebStateError) throw error;
    throw new WebStateError('Cannot save managed settings. Check the private directory and file permissions.', 500);
  } finally {
    if (temporary !== undefined) await unlink(temporary).catch(() => undefined);
  }
}

async function withWriteLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  try { await ensureDirectory(path, true); }
  catch { throw new WebStateError('Managed settings require a private writable directory (mode 0700).', 500); }
  const lockPath = `${path}.lock`;
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WebStateError('Another settings save is in progress. Retry after it finishes; a lock left after a crash must be removed while the UI is stopped.', 409);
    }
    throw new WebStateError('Cannot lock managed settings for writing. Check the private directory permissions.', 500);
  }
  try { return await action(); }
  finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function openManagedStore(
  statePath: string,
  initial?: { config: unknown; secrets: NodeJS.ProcessEnv },
): Promise<ManagedStore> {
  const path = resolve(statePath);
  let settings = await readSettings(path);
  if (settings !== null && initial !== undefined) {
    throw new WebStateError('State file already contains settings; omit --config or choose a new --state-file.');
  }
  if (settings === null && initial !== undefined) {
    settings = await withWriteLock(path, async () => {
      if (await readSettings(path) !== null) throw new WebStateError('State file already contains settings; omit --config or choose a new --state-file.');
      const imported = validateSettings(initial.config, initial.secrets);
      await writeSettings(path, imported);
      return imported;
    });
  }
  let pending: Promise<unknown> = Promise.resolve();
  return {
    snapshot: () => ({
      revision: revisionFor(settings),
      config: settings === null ? null : structuredClone(settings.config),
      configuredSecrets: settings === null ? [] : Object.keys(settings.secrets).sort(),
    }),
    resolvedConfig: () => settings === null ? null : parseConfig(settings.config, settings.secrets),
    save(revision, config, secrets) {
      const save = async (): Promise<Config> => withWriteLock(path, async () => {
        settings = await readSettings(path);
        if (revision !== revisionFor(settings)) throw new WebStateError('Settings changed in another session. Reload before saving again.', 409);
        const updates = validateSecrets(secrets);
        const merged = Object.fromEntries([
          ...Object.entries(settings?.secrets ?? {}),
          ...Object.entries(updates).filter(([, value]) => value.trim()),
        ]);
        const next = validateSettings(config, merged);
        await writeSettings(path, next);
        settings = next;
        return parseConfig(next.config, next.secrets);
      });
      const result = pending.then(save);
      pending = result.catch(() => undefined);
      return result;
    },
  };
}

export async function loadManagedConfig(statePath: string): Promise<Config | null> {
  const settings = await readSettings(resolve(statePath));
  return settings === null ? null : parseConfig(settings.config, settings.secrets);
}
