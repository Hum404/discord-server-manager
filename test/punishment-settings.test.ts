import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/store.js';

const defaults = {
  punishmentChannelId: null, punishmentNoticesEnabled: false,
  punishmentDmEnabled: true, punishmentIncludeSubareas: false,
};

function notices(store: Store, guildId: string) {
  const { punishmentChannelId, punishmentNoticesEnabled, punishmentDmEnabled, punishmentIncludeSubareas } = store.getSettings(guildId);
  return { punishmentChannelId, punishmentNoticesEnabled, punishmentDmEnabled, punishmentIncludeSubareas };
}

test('new guilds retain existing punishment DMs and require opting into public announcements', () => {
  const store = new Store(':memory:');
  try {
    assert.deepEqual(notices(store, 'guild-a'), defaults);
    store.updateSettings('guild-a', { logChannelId: 'logs' });
    assert.deepEqual(notices(store, 'guild-a'), defaults);
    for (const key of ['punishmentNoticesEnabled', 'punishmentDmEnabled', 'punishmentIncludeSubareas'] as const) {
      assert.equal(typeof store.getSettings('guild-a')[key], 'boolean');
    }
  } finally { store.close(); }
});

test('punishment switches and destination remain isolated between guilds and independent from other settings', () => {
  const store = new Store(':memory:');
  try {
    const enabled = {
      punishmentChannelId: 'announcements-a', punishmentNoticesEnabled: true,
      punishmentDmEnabled: false, punishmentIncludeSubareas: true,
    };
    store.updateSettings('guild-a', { ...enabled, logChannelId: 'private-logs-a', welcomeMessage: '歡迎 {user}' });
    assert.deepEqual(notices(store, 'guild-a'), enabled);
    assert.deepEqual(notices(store, 'guild-b'), defaults);
    store.updateSettings('guild-b', { punishmentChannelId: 'announcements-b', punishmentNoticesEnabled: true });
    store.updateSettings('guild-a', { punishmentNoticesEnabled: false });
    assert.equal(store.getSettings('guild-a').punishmentChannelId, 'announcements-a');
    assert.equal(store.getSettings('guild-a').punishmentDmEnabled, false);
    assert.equal(store.getSettings('guild-a').punishmentIncludeSubareas, true);
    assert.equal(store.getSettings('guild-a').logChannelId, 'private-logs-a');
    assert.equal(store.getSettings('guild-a').welcomeMessage, '歡迎 {user}');
    assert.equal(store.getSettings('guild-b').punishmentNoticesEnabled, true);
    assert.equal(store.getSettings('guild-b').punishmentChannelId, 'announcements-b');
    store.updateSettings('guild-a', { punishmentChannelId: null });
    assert.equal(store.getSettings('guild-a').punishmentChannelId, null);
  } finally { store.close(); }
});

test('all punishment announcement settings survive restart and sparse updates preserve false switches', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-punishment-settings-'));
  const path = join(directory, 'bot.sqlite');
  let store = new Store(path);
  try {
    const configured = {
      punishmentChannelId: 'post-a', punishmentNoticesEnabled: true,
      punishmentDmEnabled: false, punishmentIncludeSubareas: true,
    };
    store.updateSettings('guild-a', configured);
    store.close();
    store = new Store(path);
    assert.deepEqual(notices(store, 'guild-a'), configured);
    store.updateSettings('guild-a', { welcomeChannelId: 'welcome', punishmentDmEnabled: undefined });
    assert.deepEqual(notices(store, 'guild-a'), configured);
    store.updateSettings('guild-a', { punishmentNoticesEnabled: false, punishmentIncludeSubareas: false });
    store.close();
    store = new Store(path);
    assert.deepEqual(notices(store, 'guild-a'), { ...configured, punishmentNoticesEnabled: false, punishmentIncludeSubareas: false });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy settings migration preserves existing channels and does not silently enable public notices', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-punishment-migration-'));
  const path = join(directory, 'bot.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE guild_settings (
      guild_id TEXT PRIMARY KEY, log_channel_id TEXT, welcome_channel_id TEXT,
      welcome_message TEXT NOT NULL
    );
    INSERT INTO guild_settings VALUES ('guild-a', 'existing-logs', 'existing-welcome', '你好 {user}');
  `);
  old.close();
  let store = new Store(path);
  try {
    assert.deepEqual(notices(store, 'guild-a'), defaults);
    assert.equal(store.getSettings('guild-a').logChannelId, 'existing-logs');
    assert.equal(store.getSettings('guild-a').welcomeChannelId, 'existing-welcome');
    assert.equal(store.getSettings('guild-a').welcomeMessage, '你好 {user}');
    store.updateSettings('guild-a', { punishmentChannelId: 'new-post', punishmentNoticesEnabled: true });
    store.close();
    store = new Store(path);
    assert.equal(store.getSettings('guild-a').punishmentChannelId, 'new-post');
    assert.equal(store.getSettings('guild-a').punishmentNoticesEnabled, true);
    assert.equal(store.getSettings('guild-a').logChannelId, 'existing-logs');
    assert.equal(store.getSettings('guild-a').punishmentDmEnabled, true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid punishment settings are rejected without changing any stored settings', () => {
  const store = new Store(':memory:');
  try {
    store.updateSettings('guild-a', { punishmentChannelId: 'existing', punishmentNoticesEnabled: true });
    const before = store.getSettings('guild-a');
    for (const key of ['punishmentNoticesEnabled', 'punishmentDmEnabled', 'punishmentIncludeSubareas'] as const) {
      for (const invalid of [0, 1, 'false', 'true', '', null, {}, []]) {
        assert.throws(() => store.updateSettings('guild-a', { [key]: invalid } as unknown as Parameters<Store['updateSettings']>[1]), TypeError);
        assert.deepEqual(store.getSettings('guild-a'), before);
      }
    }
    for (const invalid of ['', ' ', 'x'.repeat(65), 1, false, {}]) {
      assert.throws(() => store.updateSettings('guild-a', { punishmentChannelId: invalid } as unknown as Parameters<Store['updateSettings']>[1]), TypeError);
      assert.deepEqual(store.getSettings('guild-a'), before);
    }
  } finally { store.close(); }
});
