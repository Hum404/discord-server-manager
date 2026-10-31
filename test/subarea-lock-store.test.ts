import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store, type SubareaLockMetadata, type SubareaLockMetadataPatch } from '../src/store.js';

const baseline = JSON.stringify([{ id: 'owner', type: 1, allow: '2048', deny: '0', existed: true }]);

function withStore(run: (store: Store) => void) {
  return () => {
    const store = new Store(':memory:');
    try {
      store.setSubarea('guild-a', 'channel', 'owner');
      store.setSubarea('guild-b', 'channel', 'owner');
      run(store);
    } finally { store.close(); }
  };
}

test('legacy lock metadata migrates once without replacing baselines, actors or timestamps', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-lock-metadata-'));
  const path = join(directory, 'bot.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE subareas(guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    owner_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(guild_id, channel_id));
    CREATE TABLE subarea_locks(guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, overwrites TEXT NOT NULL,
      locked_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(guild_id, channel_id),
      FOREIGN KEY(guild_id, channel_id) REFERENCES subareas(guild_id, channel_id) ON DELETE CASCADE);
    INSERT INTO subareas VALUES('guild-a', 'channel', 'owner', '2026-01-01T00:00:00.000Z');
    INSERT INTO subareas VALUES('guild-b', 'channel', 'owner', '2026-01-01T00:00:00.000Z');`);
  const insert = legacy.prepare('INSERT INTO subarea_locks VALUES(?, ?, ?, ?, ?)');
  insert.run('guild-a', 'channel', baseline, 'original-actor', '2026-02-01T00:00:00.000Z');
  insert.run('guild-b', 'channel', '[]', 'other-actor', '2026-03-01T00:00:00.000Z');
  legacy.close();
  let store: Store | undefined;
  try {
    store = new Store(path);
    const saved = store.getSubareaLock('guild-a', 'channel')!;
    assert.match(saved.lockId, /^[0-9a-f]{16}$/);
    assert.equal(saved.mode, 'legacy');
    assert.equal(saved.source, 'legacy');
    assert.equal(saved.originalArchived, null);
    assert.equal(saved.originalLocked, null);
    assert.equal(saved.overwrites, baseline);
    assert.equal(saved.lockedBy, 'original-actor');
    assert.equal(saved.createdAt, '2026-02-01T00:00:00.000Z');
    assert.notEqual(store.getSubareaLock('guild-b', 'channel')!.lockId, saved.lockId);
    store.close(); store = undefined;
    store = new Store(path);
    assert.deepEqual(store.getSubareaLock('guild-a', 'channel'), saved);
    assert.equal(store.listSubareaLocks().length, 2);
    assert.deepEqual(store.listSubareaLocks('guild-a'), [saved]);
    store.deleteSubarea('guild-a', 'channel');
    assert.equal(store.getSubareaLock('guild-a', 'channel'), null);
    assert.equal(store.getSubareaLock('guild-b', 'channel')!.lockedBy, 'other-actor');
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('new native lock metadata round-trips booleans and first-write preserves the recovery generation', withStore((store) => {
  const saved = store.setSubareaLock('guild-a', 'channel', '[]', 'owner', {
    mode: 'thread-native', source: 'owner', originalArchived: false, originalLocked: true,
  });
  assert.equal(saved.originalArchived, false);
  assert.equal(saved.originalLocked, true);
  assert.equal(saved.mode, 'thread-native');
  assert.equal(saved.source, 'owner');
  assert.match(saved.lockId, /^[0-9a-f]{16}$/);
  assert.deepEqual(store.setSubareaLock('guild-a', 'channel', baseline, 'staff', {
    mode: 'text', source: 'admin', originalArchived: true, originalLocked: false,
  }), saved);
  assert.deepEqual(store.listSubareaLocks('guild-a'), [saved]);
  const other = store.setSubareaLock('guild-b', 'channel', baseline, 'owner');
  assert.equal(other.mode, 'legacy');
  assert.equal(other.source, 'legacy');
  assert.equal(other.originalArchived, null);
  assert.equal(other.originalLocked, null);
  assert.notEqual(other.lockId, saved.lockId);
}));

test('authority promotion invalidates old recovery controls while preserving the permission baseline', withStore((store) => {
  const saved = store.setSubareaLock('guild-a', 'channel', baseline, 'owner', { mode: 'text', source: 'owner' });
  const promoted = store.updateSubareaLockMetadata('guild-a', 'channel', { source: 'admin', lockedBy: 'staff' }, saved.lockId)!;
  assert.equal(promoted.source, 'admin');
  assert.equal(promoted.lockedBy, 'staff');
  assert.equal(promoted.mode, 'text');
  assert.equal(promoted.overwrites, saved.overwrites);
  assert.equal(promoted.createdAt, saved.createdAt);
  assert.notEqual(promoted.lockId, saved.lockId);
  assert.match(promoted.lockId, /^[0-9a-f]{16}$/);
  assert.equal(store.updateSubareaLockMetadata('guild-a', 'channel', { source: 'owner' }, saved.lockId), null);
  assert.deepEqual(store.getSubareaLock('guild-a', 'channel'), promoted);
  const changed = store.updateSubareaLockMetadata('guild-a', 'channel', {
    mode: 'thread-native', originalArchived: false, originalLocked: false,
  }, promoted.lockId)!;
  assert.equal(changed.source, 'admin');
  assert.equal(changed.overwrites, baseline);
  assert.equal(changed.originalArchived, false);
  assert.equal(changed.originalLocked, false);
  assert.notEqual(changed.lockId, promoted.lockId);
  const unknownOriginal = store.updateSubareaLockMetadata('guild-a', 'channel', {
    originalArchived: null, originalLocked: null,
  })!;
  assert.equal(unknownOriginal.originalArchived, null);
  assert.equal(unknownOriginal.originalLocked, null);
}));

test('metadata changes cannot cross guilds, resurrect removed locks or reuse a prior generation', withStore((store) => {
  const saved = store.setSubareaLock('guild-a', 'channel', baseline, 'owner', { mode: 'text', source: 'owner' });
  assert.equal(store.updateSubareaLockMetadata('guild-b', 'channel', { source: 'admin' }, saved.lockId), null);
  assert.equal(store.updateSubareaLockMetadata('guild-a', 'absent', { source: 'admin' }, saved.lockId), null);
  store.setSubareaLock('guild-b', 'channel', '[]', 'delegate', { mode: 'thread-native', source: 'delegate' });
  assert.equal(store.updateSubareaLockMetadata('guild-b', 'channel', { source: 'admin' }, saved.lockId), null);
  assert.equal(store.getSubareaLock('guild-b', 'channel')!.source, 'delegate');
  store.deleteSubareaLock('guild-a', 'channel');
  assert.equal(store.updateSubareaLockMetadata('guild-a', 'channel', { source: 'admin' }, saved.lockId), null);
  const replacement = store.setSubareaLock('guild-a', 'channel', '[]', 'owner');
  assert.notEqual(replacement.lockId, saved.lockId);
  assert.equal(store.updateSubareaLockMetadata('guild-a', 'channel', { source: 'admin' }, saved.lockId), null);
}));

test('invalid lock metadata or recovery generations fail before altering stored policy', withStore((store) => {
  const saved = store.setSubareaLock('guild-a', 'channel', baseline, 'owner');
  for (const patch of [null, [], { mode: 'thread-soft' }, { source: 'moderator' }, { source: '' },
    { originalArchived: 1 }, { originalLocked: 'false' }, { lockedBy: '' }, { lockId: '0000000000000000' }]) {
    assert.throws(() => store.updateSubareaLockMetadata('guild-a', 'channel', patch as SubareaLockMetadataPatch), TypeError);
  }
  for (const nonce of ['', 'A'.repeat(16), '0'.repeat(15), '0'.repeat(17), 'g'.repeat(16)]) {
    assert.throws(() => store.updateSubareaLockMetadata('guild-a', 'channel', { source: 'admin' }, nonce), TypeError);
  }
  for (const metadata of [null, [], { mode: 'text' }, { source: 'owner' }, { mode: 'bad', source: 'owner' },
    { mode: 'text', source: 'staff' }, { mode: 'thread-native', source: 'owner', originalArchived: 0 },
    { mode: 'thread-native', source: 'owner', originalLocked: 'true' }]) {
    assert.throws(() => store.setSubareaLock('guild-b', 'channel', '[]', 'owner', metadata as SubareaLockMetadata), TypeError);
  }
  assert.deepEqual(store.getSubareaLock('guild-a', 'channel'), saved);
  assert.equal(store.getSubareaLock('guild-b', 'channel'), null);
}));

test('native metadata and rotated recovery generations survive a database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-native-lock-'));
  const path = join(directory, 'bot.sqlite');
  let store: Store | undefined;
  try {
    store = new Store(path);
    store.setSubarea('guild', 'channel', 'owner');
    const original = store.setSubareaLock('guild', 'channel', baseline, 'delegate', {
      mode: 'thread-native', source: 'delegate', originalArchived: true, originalLocked: false,
    });
    const saved = store.updateSubareaLockMetadata('guild', 'channel', { source: 'admin', lockedBy: 'staff' }, original.lockId)!;
    store.close(); store = undefined;
    store = new Store(path);
    assert.deepEqual(store.getSubareaLock('guild', 'channel'), saved);
    assert.equal(store.updateSubareaLockMetadata('guild', 'channel', { source: 'owner' }, original.lockId), null);
    assert.equal(store.listSubareaLocks('guild')[0]!.originalArchived, true);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
