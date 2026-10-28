import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/store.js';

const baseline = JSON.stringify([{ id: 'guild-a', type: 0, allow: '1024', deny: '0' },
  { id: 'member', type: 1, allow: '0', deny: '2048' }]);

test('delegates isolate guilds and channels and are cleared only when ownership changes', () => {
  const store = new Store(':memory:');
  try {
    store.setSubarea('guild-a', 'channel', 'owner');
    store.setSubarea('guild-a', 'other-channel', 'owner');
    store.setSubarea('guild-b', 'channel', 'owner');
    store.setSubareaDelegate('guild-a', 'channel', 'delegate', 'owner');
    store.setSubareaDelegate('guild-a', 'other-channel', 'delegate', 'owner');
    store.setSubareaDelegate('guild-b', 'channel', 'delegate', 'owner');
    assert.equal(store.getSubareaDelegate('guild-a', 'channel', 'delegate')?.grantedBy, 'owner');
    assert.equal(store.getSubareaDelegate('guild-a', 'channel', 'other'), null);
    store.setSubareaDelegate('guild-a', 'channel', 'delegate', 'admin');
    assert.equal(store.listSubareaDelegates('guild-a', 'channel').length, 1);
    assert.equal(store.getSubareaDelegate('guild-a', 'channel', 'delegate')?.grantedBy, 'admin');
    const original = store.getSubarea('guild-a', 'channel');
    store.setSubarea('guild-a', 'channel', 'owner');
    assert.equal(store.listSubareaDelegates('guild-a', 'channel').length, 1);
    store.setSubareaLock('guild-a', 'channel', baseline, 'owner');
    store.setSubarea('guild-a', 'channel', 'new-owner');
    assert.equal(store.listSubareaDelegates('guild-a', 'channel').length, 0);
    assert.equal(store.getSubarea('guild-a', 'channel')?.createdAt, original?.createdAt);
    assert.equal(store.getSubareaLock('guild-a', 'channel')?.overwrites, baseline);
    assert.equal(store.listSubareaDelegates('guild-a', 'other-channel').length, 1);
    assert.equal(store.listSubareaDelegates('guild-b', 'channel').length, 1);
    assert.equal(store.deleteSubareaDelegate('guild-b', 'channel', 'delegate'), true);
    assert.equal(store.deleteSubareaDelegate('guild-b', 'channel', 'delegate'), false);
    assert.equal(store.clearSubareaDelegates('guild-a', 'other-channel'), 1);
    assert.equal(store.clearSubareaDelegates('guild-a', 'other-channel'), 0);
    assert.throws(() => store.setSubareaDelegate('guild-a', 'absent', 'delegate', 'owner'));
  } finally { store.close(); }
});

test('an owner transfer rolls back both ownership and delegates when delegate cleanup fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-owner-atomic-'));
  const path = join(directory, 'bot.sqlite');
  const store = new Store(path);
  const control = new DatabaseSync(path);
  try {
    store.setSubarea('guild-a', 'channel', 'owner');
    store.setSubareaDelegate('guild-a', 'channel', 'delegate', 'owner');
    control.exec(`CREATE TRIGGER fail_delegate_delete BEFORE DELETE ON subarea_delegates
      BEGIN SELECT RAISE(ABORT, 'simulated cleanup failure'); END;`);
    assert.throws(() => store.setSubarea('guild-a', 'channel', 'new-owner'));
    assert.equal(store.getSubarea('guild-a', 'channel')?.ownerId, 'owner');
    assert.equal(store.getSubareaDelegate('guild-a', 'channel', 'delegate')?.grantedBy, 'owner');
    control.exec('DROP TRIGGER fail_delegate_delete');
    store.setSubarea('guild-a', 'channel', 'new-owner');
    assert.equal(store.getSubarea('guild-a', 'channel')?.ownerId, 'new-owner');
    assert.equal(store.getSubareaDelegate('guild-a', 'channel', 'delegate'), null);
  } finally {
    control.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('lock baselines preserve the first snapshot and cascade with their registered subarea', () => {
  const store = new Store(':memory:');
  try {
    store.setSubarea('guild-a', 'channel', 'owner');
    store.setSubarea('guild-b', 'channel', 'owner');
    const saved = store.setSubareaLock('guild-a', 'channel', baseline, 'owner');
    assert.deepEqual({ ...store.setSubareaLock('guild-a', 'channel', '[]', 'other') }, { ...saved });
    assert.equal(store.getSubareaLock('guild-b', 'channel'), null);
    store.setSubareaLock('guild-b', 'channel', '[]', 'other');
    assert.equal(store.listSubareaLocks().length, 2);
    assert.equal(store.listSubareaLocks('guild-a')[0]?.overwrites, baseline);
    store.setSubareaDelegate('guild-a', 'channel', 'delegate', 'owner');
    store.deleteSubarea('guild-a', 'channel');
    assert.equal(store.getSubareaLock('guild-a', 'channel'), null);
    assert.equal(store.getSubareaDelegate('guild-a', 'channel', 'delegate'), null);
    assert.equal(store.getSubareaLock('guild-b', 'channel')?.lockedBy, 'other');
    assert.equal(store.deleteSubareaLock('guild-b', 'channel'), true);
    assert.equal(store.deleteSubareaLock('guild-b', 'channel'), false);
    assert.throws(() => store.setSubareaLock('guild-a', 'absent', baseline, 'owner'));
  } finally { store.close(); }
});

test('lock baselines reject malformed, duplicate or oversized permission snapshots', () => {
  const store = new Store(':memory:');
  try {
    store.setSubarea('guild-a', 'channel', 'owner');
    const invalid = [' ', '{', 'null', '{}', '[null]', '[[]]',
      JSON.stringify([{ id: '', type: 0, allow: '0', deny: '0' }]),
      JSON.stringify([{ id: 'id', type: 2, allow: '0', deny: '0' }]),
      JSON.stringify([{ id: 'id', type: 0, allow: 0, deny: '0' }]),
      JSON.stringify([{ id: 'id', type: 0, allow: '-1', deny: '0' }]),
      JSON.stringify([{ id: 'id', type: 0, allow: '0', deny: null }]),
      JSON.stringify([{ id: 'id', type: 0, allow: '0', deny: '0' }, { id: 'id', type: 1, allow: '0', deny: '0' }]),
      JSON.stringify(Array.from({ length: 1001 }, (_, id) => ({ id: String(id), type: 0, allow: '0', deny: '0' }))),
      ' '.repeat(1_000_001)];
    for (const value of invalid) assert.throws(() => store.setSubareaLock('guild-a', 'channel', value, 'owner'), TypeError);
    assert.equal(store.getSubareaLock('guild-a', 'channel'), null);
    assert.equal(store.setSubareaLock('guild-a', 'channel', baseline, 'owner').overwrites, baseline);
  } finally { store.close(); }
});

test('warning removal cannot cross guilds or alter immutable case and appeal history', () => {
  const store = new Store(':memory:');
  try {
    const warning = store.addWarning({ guildId: 'guild-a', userId: 'user', moderatorId: 'mod', reason: 'test' });
    const original = store.addCase({ guildId: 'guild-a', userId: 'user', moderatorId: 'mod', action: 'warn', reason: 'test' });
    const appeal = store.createAppeal({ guildId: 'guild-a', userId: 'user', caseId: original.id, reason: 'review' });
    assert.equal(store.removeWarning('guild-b', warning.id), null);
    assert.equal(store.getWarning('guild-b', warning.id), null);
    assert.equal(store.getWarning('guild-a', warning.id)?.userId, 'user');
    assert.equal(store.countWarnings('guild-a', 'user'), 1);
    assert.deepEqual({ ...store.removeWarning('guild-a', warning.id) }, warning);
    assert.equal(store.countWarnings('guild-a', 'user'), 0);
    assert.equal(store.removeWarning('guild-a', warning.id), null);
    assert.equal(store.getCase(original.id)?.reason, 'test');
    assert.equal(store.getAppeal(appeal.id)?.caseId, original.id);
    for (const invalid of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => store.removeWarning('guild-a', invalid), RangeError);
    }
  } finally { store.close(); }
});

test('management schema migrates an existing installation and survives repeated startup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-management-migrate-'));
  const path = join(directory, 'bot.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE subareas (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    owner_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(guild_id, channel_id));
    INSERT INTO subareas VALUES('guild-a', 'channel', 'owner', '2026-01-01T00:00:00.000Z');`);
  legacy.close();
  let store = new Store(path);
  try {
    store.setSubareaDelegate('guild-a', 'channel', 'delegate', 'owner');
    store.setSubareaLock('guild-a', 'channel', baseline, 'owner');
    const oldWarning = store.addWarning({ guildId: 'guild-a', userId: 'user', moderatorId: 'mod', reason: 'kept' });
    store.close();
    store = new Store(path);
    assert.equal(store.getSubarea('guild-a', 'channel')?.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(store.getSettings('guild-a').subareaForumId, null);
    store.updateSettings('guild-a', { subareaForumId: 'forum' });
    assert.equal(store.getSubareaDelegate('guild-a', 'channel', 'delegate')?.grantedBy, 'owner');
    assert.equal(store.getSubareaLock('guild-a', 'channel')?.overwrites, baseline);
    assert.equal(store.listWarnings('guild-a', 'user')[0]?.id, oldWarning.id);
    store.close();
    store = new Store(path);
    assert.equal(store.listSubareaDelegates('guild-a', 'channel').length, 1);
    assert.equal(store.getSubareaLock('guild-a', 'channel')?.lockedBy, 'owner');
    assert.equal(store.getSettings('guild-a').subareaForumId, 'forum');
    store.updateSettings('guild-a', { welcomeMessage: 'new welcome' });
    assert.equal(store.getSettings('guild-a').subareaForumId, 'forum');
    store.updateSettings('guild-a', { subareaForumId: null });
    assert.equal(store.getSettings('guild-a').subareaForumId, null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
