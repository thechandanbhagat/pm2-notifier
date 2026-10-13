import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchGetUriManifest, patchPm2Manifest } from '../scripts/patch-bundled-dependencies';

const ORIGINAL_RANGE = '^5.0.2';
const PATCHED_RANGE = '^6.2.3';
const manifest = {
  name: 'get-uri',
  version: '6.0.5',
  main: './dist/index.js',
  dependencies: { 'basic-ftp': ORIGINAL_RANGE, debug: '^4.3.4' },
  engines: { node: '>= 14' },
};

test('patchGetUriManifest changes only the basic-ftp range without mutating the input', () => {
  const input = Object.freeze({ ...manifest, dependencies: Object.freeze({ ...manifest.dependencies }) });
  const patched = patchGetUriManifest(input);

  assert.deepEqual(patched, { ...manifest, dependencies: { ...manifest.dependencies, 'basic-ftp': PATCHED_RANGE } });
  assert.notEqual(patched, input);
  assert.notEqual(patched.dependencies, input.dependencies);
  assert.equal(patched.engines, input.engines);
  assert.equal(input.dependencies['basic-ftp'], ORIGINAL_RANGE);
});

test('patchGetUriManifest is idempotent for an already patched manifest', () => {
  const patched = patchGetUriManifest(manifest);
  assert.equal(patchGetUriManifest(patched), patched);
});

test('patchGetUriManifest accepts plain objects with null prototypes', () => {
  const input: unknown = Object.assign(Object.create(null), manifest, {
    dependencies: Object.assign(Object.create(null), manifest.dependencies),
  });
  assert.equal(patchGetUriManifest(input).dependencies['basic-ftp'], PATCHED_RANGE);
});

for (const [description, input] of [
  ['empty object', {}],
  ['null', null],
  ['undefined', undefined],
  ['array', []],
  ['string', 'get-uri'],
  ['number', Number.MAX_SAFE_INTEGER],
  ['custom prototype', Object.create(manifest)],
  ['wrong name', { ...manifest, name: 'another-package' }],
  ['wrong version', { ...manifest, version: '6.0.6' }],
  ['missing dependencies', { name: manifest.name, version: manifest.version }],
  ['null dependencies', { ...manifest, dependencies: null }],
  ['array dependencies', { ...manifest, dependencies: [] }],
  ['custom dependency prototype', { ...manifest, dependencies: Object.create(manifest.dependencies) }],
  ['empty dependencies', { ...manifest, dependencies: {} }],
  ['unexpected range', { ...manifest, dependencies: { 'basic-ftp': '^7.0.0' } }],
  ['non-string range', { ...manifest, dependencies: { 'basic-ftp': Number.MAX_SAFE_INTEGER } }],
] as const) {
  test(`patchGetUriManifest rejects ${description}`, () => {
    assert.throws(() => patchGetUriManifest(input), /Expected/);
  });
}

const ORIGINAL_JS_YAML_RANGE = '4.3.1';
const PATCHED_JS_YAML_RANGE = '^4.3.2';
const pm2Manifest = {
  name: 'pm2',
  version: '7.0.4',
  main: 'index.js',
  dependencies: { 'js-yaml': ORIGINAL_JS_YAML_RANGE, debug: '^4.3.4' },
  engines: { node: '>=18' },
};

test('patchPm2Manifest changes only the js-yaml range without mutating the input', () => {
  const input = Object.freeze({ ...pm2Manifest, dependencies: Object.freeze({ ...pm2Manifest.dependencies }) });
  const patched = patchPm2Manifest(input);

  assert.deepEqual(patched, { ...pm2Manifest, dependencies: { ...pm2Manifest.dependencies, 'js-yaml': PATCHED_JS_YAML_RANGE } });
  assert.notEqual(patched, input);
  assert.notEqual(patched.dependencies, input.dependencies);
  assert.equal(patched.engines, input.engines);
  assert.equal(input.dependencies['js-yaml'], ORIGINAL_JS_YAML_RANGE);
});

test('patchPm2Manifest is idempotent for an already patched manifest', () => {
  const patched = patchPm2Manifest(pm2Manifest);
  assert.equal(patchPm2Manifest(patched), patched);
});

test('patchPm2Manifest accepts plain objects with null prototypes', () => {
  const input: unknown = Object.assign(Object.create(null), pm2Manifest, {
    dependencies: Object.assign(Object.create(null), pm2Manifest.dependencies),
  });
  assert.equal(patchPm2Manifest(input).dependencies['js-yaml'], PATCHED_JS_YAML_RANGE);
});

for (const [description, input] of [
  ['empty object', {}],
  ['null', null],
  ['undefined', undefined],
  ['array', []],
  ['string', 'pm2'],
  ['number', Number.MAX_SAFE_INTEGER],
  ['custom prototype', Object.create(pm2Manifest)],
  ['wrong name', { ...pm2Manifest, name: 'another-package' }],
  ['wrong version', { ...pm2Manifest, version: '7.0.5' }],
  ['missing dependencies', { name: pm2Manifest.name, version: pm2Manifest.version }],
  ['null dependencies', { ...pm2Manifest, dependencies: null }],
  ['array dependencies', { ...pm2Manifest, dependencies: [] }],
  ['custom dependency prototype', { ...pm2Manifest, dependencies: Object.create(pm2Manifest.dependencies) }],
  ['empty dependencies', { ...pm2Manifest, dependencies: {} }],
  ['unexpected range', { ...pm2Manifest, dependencies: { 'js-yaml': '^5.0.0' } }],
  ['non-string range', { ...pm2Manifest, dependencies: { 'js-yaml': Number.MAX_SAFE_INTEGER } }],
] as const) {
  test(`patchPm2Manifest rejects ${description}`, () => {
    assert.throws(() => patchPm2Manifest(input), /Expected/);
  });
}
