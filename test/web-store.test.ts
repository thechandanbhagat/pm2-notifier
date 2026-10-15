import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManagedConfig, openManagedStore, WebStateError } from '../src/web-store';

const input = {
  destinations: [{ id: 'ops', format: 'generic', urlEnv: 'HOOK', headersEnv: { Authorization: 'AUTH' } }],
  routes: [{ destinations: ['ops'] }],
};
const secrets = { HOOK: 'https://example.invalid/private-secret', AUTH: 'Bearer private-token' };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pm2-notifier-web-store-'));
  return { directory, path: join(directory, 'private', 'settings.json'), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('managed settings persist atomically with private permissions and expose no resolved secrets', async () => {
  const file = await fixture();
  try {
    const store = await openManagedStore(file.path);
    assert.equal(store.snapshot().config, null);
    assert.equal(await loadManagedConfig(file.path), null);
    const before = store.snapshot().revision;
    const config = await store.save(before, input, { ...secrets, UNRELATED: 'do-not-save' });
    assert.equal(config.destinations[0].url, secrets.HOOK);
    assert.notEqual(store.snapshot().revision, before);
    assert.deepEqual(store.snapshot().configuredSecrets, ['AUTH', 'HOOK']);
    assert.equal(store.snapshot().config?.destinations[0].urlEnv, 'HOOK');
    const visible = JSON.stringify(store.snapshot());
    assert.ok(!visible.includes('private-secret'));
    assert.ok(!visible.includes('private-token'));
    assert.equal((await lstat(join(file.directory, 'private'))).mode & 0o777, 0o700);
    assert.equal((await lstat(file.path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(file.directory, 'private')), ['settings.json']);
    const stored = JSON.parse(await readFile(file.path, 'utf8'));
    assert.deepEqual(stored.secrets, secrets);
    assert.deepEqual((await loadManagedConfig(file.path))?.destinations[0].headers, { Authorization: secrets.AUTH });
    const reopened = await openManagedStore(file.path);
    assert.equal(reopened.snapshot().revision, store.snapshot().revision);
    const snapshot = store.snapshot();
    snapshot.config!.destinations[0].id = 'changed-copy';
    assert.equal(store.snapshot().config?.destinations[0].id, 'ops');
  } finally { await file.cleanup(); }
});

test('blank credentials retain saved values, changes rotate revisions, and removing references prunes credentials', async () => {
  const file = await fixture();
  try {
    const store = await openManagedStore(file.path, { config: input, secrets });
    const original = store.snapshot().revision;
    await store.save(original, input, { HOOK: '', AUTH: '   ' });
    assert.equal(store.snapshot().revision, original);
    assert.equal(store.resolvedConfig()?.destinations[0].headers.Authorization, secrets.AUTH);
    await store.save(original, input, { AUTH: 'Bearer replacement' });
    assert.notEqual(store.snapshot().revision, original);
    const next = { ...input, destinations: [{ id: 'ops', format: 'generic', urlEnv: 'HOOK' }] };
    await store.save(store.snapshot().revision, next, {});
    assert.deepEqual(store.snapshot().configuredSecrets, ['HOOK']);
    assert.ok(!(await readFile(file.path, 'utf8')).includes('replacement'));
  } finally { await file.cleanup(); }
});

test('simultaneous saves reject a stale revision and validation failures keep previous settings', async () => {
  const file = await fixture();
  try {
    const store = await openManagedStore(file.path, { config: input, secrets });
    const revision = store.snapshot().revision;
    const saves = await Promise.allSettled([
      store.save(revision, { ...input, hostname: 'first' }, {}),
      store.save(revision, { ...input, hostname: 'second' }, {}),
    ]);
    assert.equal(saves[0].status, 'fulfilled');
    assert.equal(saves[1].status, 'rejected');
    if (saves[1].status === 'rejected') assert.equal((saves[1].reason as WebStateError).status, 409);
    const bytes = await readFile(file.path, 'utf8');
    await assert.rejects(store.save(store.snapshot().revision, { ...input, ['SECRET-UNKNOWN-KEY']: true }, {}), error => {
      assert.ok(!String(error).includes('SECRET-UNKNOWN-KEY'));
      return true;
    });
    await assert.rejects(store.save(store.snapshot().revision, input, { HOOK: 'https://secret-user:secret-pass@example.invalid/' }), /HTTPS without URL credentials/);
    assert.equal(await readFile(file.path, 'utf8'), bytes);
    assert.equal(store.snapshot().config?.hostname, 'first');
  } finally { await file.cleanup(); }
});

test('initial import copies only referenced secrets and refuses to overwrite existing managed state', async () => {
  const file = await fixture();
  try {
    await openManagedStore(file.path, { config: input, secrets: { ...secrets, OTHER_APPLICATION_SECRET: 'unrelated' } });
    assert.ok(!(await readFile(file.path, 'utf8')).includes('unrelated'));
    await assert.rejects(openManagedStore(file.path, { config: input, secrets }), /already contains settings/);
  } finally { await file.cleanup(); }
});

test('independent stores coordinate writes and cannot silently overwrite the same revision', async () => {
  const file = await fixture();
  try {
    const first = await openManagedStore(file.path, { config: input, secrets });
    const second = await openManagedStore(file.path);
    const revision = first.snapshot().revision;
    const results = await Promise.allSettled([
      first.save(revision, { ...input, hostname: 'first' }, {}),
      second.save(revision, { ...input, hostname: 'second' }, {}),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected?.status === 'rejected' && (rejected.reason as WebStateError).status, 409);
    const winner = results[0].status === 'fulfilled' ? 'first' : 'second';
    assert.equal((await loadManagedConfig(file.path))?.hostname, winner);
    assert.deepEqual(await readdir(join(file.directory, 'private')), ['settings.json']);
    await writeFile(`${file.path}.lock`, '', { mode: 0o600 });
    await assert.rejects(first.save(first.snapshot().revision, input, {}), /Another settings save/);
    assert.equal((await loadManagedConfig(file.path))?.hostname, winner);
  } finally { await file.cleanup(); }
});

test('symlinks, public directories or files, malformed files, and oversized state are rejected without exposing contents', async () => {
  const file = await fixture();
  try {
    const parent = join(file.directory, 'private');
    await mkdir(parent, { mode: 0o700 });
    const target = join(file.directory, 'target.json');
    await writeFile(target, 'PRIVATE-CONTENT', { mode: 0o600 });
    await symlink(target, file.path);
    await assert.rejects(openManagedStore(file.path), /Cannot read managed settings/);
    assert.equal(await readFile(target, 'utf8'), 'PRIVATE-CONTENT');
    await rm(file.path);
    await rm(parent, { recursive: true });
    await symlink(file.directory, parent);
    await assert.rejects(openManagedStore(file.path), /Cannot read managed settings/);
    await rm(parent);
    await mkdir(parent, { mode: 0o755 });
    await assert.rejects(openManagedStore(file.path), /Cannot read managed settings/);
    await chmod(parent, 0o700);
    for (const contents of ['PRIVATE-CONTENT', 'x'.repeat(1_048_577), JSON.stringify({ config: input, secrets: { HOOK: 'bad' } })]) {
      await writeFile(file.path, contents, { mode: 0o600 });
      await assert.rejects(openManagedStore(file.path), error => {
        assert.match(String(error), /Cannot read managed settings/);
        assert.ok(!String(error).includes('PRIVATE-CONTENT'));
        return true;
      });
    }
    await rm(file.path);
    await openManagedStore(file.path, { config: input, secrets });
    await chmod(file.path, 0o644);
    await assert.rejects(openManagedStore(file.path), /Cannot read managed settings/);
  } finally { await file.cleanup(); }
});

test('invalid and oversized updates cannot leave temporary files or replace saved state', async () => {
  const file = await fixture();
  try {
    const store = await openManagedStore(file.path, { config: input, secrets });
    const original = await readFile(file.path, 'utf8');
    await assert.rejects(store.save(store.snapshot().revision, input, { HOOK: 123 }), /named text values/);
    await assert.rejects(store.save(store.snapshot().revision, input, { AUTH: 'x'.repeat(1_048_577) }), /1 MiB/);
    assert.equal(await readFile(file.path, 'utf8'), original);
    assert.deepEqual(await readdir(join(file.directory, 'private')), ['settings.json']);
  } finally { await file.cleanup(); }
});
