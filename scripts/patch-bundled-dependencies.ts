import { readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const GET_URI_NAME = 'get-uri';
const GET_URI_VERSION = '6.0.5';
const ORIGINAL_BASIC_FTP_RANGE = '^5.0.2';
const PATCHED_BASIC_FTP_RANGE = '^6.2.3';
const PM2_NAME = 'pm2';
const PM2_VERSION = '7.0.4';
const ORIGINAL_JS_YAML_RANGE = '4.3.1';
const PATCHED_JS_YAML_RANGE = '^4.3.2';
const JSON_INDENTATION = 2;

type Manifest = Record<string, unknown> & { dependencies: Record<string, unknown> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function patchGetUriManifest(value: unknown): Manifest {
  if (!isPlainObject(value)) throw new Error('Expected a plain get-uri package manifest');
  if (value.name !== GET_URI_NAME || value.version !== GET_URI_VERSION) {
    throw new Error(`Expected ${GET_URI_NAME}@${GET_URI_VERSION} before patching bundled dependencies`);
  }
  if (!isPlainObject(value.dependencies)) throw new Error('Expected get-uri dependencies to be a plain object');

  const range = value.dependencies['basic-ftp'];
  if (range !== ORIGINAL_BASIC_FTP_RANGE && range !== PATCHED_BASIC_FTP_RANGE) {
    throw new Error(`Expected get-uri basic-ftp dependency ${ORIGINAL_BASIC_FTP_RANGE} or ${PATCHED_BASIC_FTP_RANGE}`);
  }
  if (range === PATCHED_BASIC_FTP_RANGE) return value as Manifest;

  return { ...value, dependencies: { ...value.dependencies, 'basic-ftp': PATCHED_BASIC_FTP_RANGE } };
}

export function patchPm2Manifest(value: unknown): Manifest {
  if (!isPlainObject(value)) throw new Error('Expected a plain pm2 package manifest');
  if (value.name !== PM2_NAME || value.version !== PM2_VERSION) {
    throw new Error(`Expected ${PM2_NAME}@${PM2_VERSION} before patching bundled dependencies`);
  }
  if (!isPlainObject(value.dependencies)) throw new Error('Expected pm2 dependencies to be a plain object');

  const range = value.dependencies['js-yaml'];
  if (range !== ORIGINAL_JS_YAML_RANGE && range !== PATCHED_JS_YAML_RANGE) {
    throw new Error(`Expected pm2 js-yaml dependency ${ORIGINAL_JS_YAML_RANGE} or ${PATCHED_JS_YAML_RANGE}`);
  }
  if (range === PATCHED_JS_YAML_RANGE) return value as Manifest;

  return { ...value, dependencies: { ...value.dependencies, 'js-yaml': PATCHED_JS_YAML_RANGE } };
}

async function patchBundledDependencies(): Promise<void> {
  for (const [packageName, patchManifest] of [[GET_URI_NAME, patchGetUriManifest], [PM2_NAME, patchPm2Manifest]] as const) {
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    const patched = patchManifest(manifest);
    if (patched !== manifest) {
      await writeFile(manifestPath, `${JSON.stringify(patched, null, JSON_INDENTATION)}\n`, 'utf8');
    }
    // Every npm install refreshes its hidden lockfile, so invalidate it even when the manifest is already patched.
    const modifiedAt = new Date();
    await utimes(dirname(manifestPath), modifiedAt, modifiedAt);
  }
}

if (require.main === module) void patchBundledDependencies();
