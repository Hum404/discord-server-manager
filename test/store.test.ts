import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_WELCOME_MESSAGE, Store } from '../src/store.js';

test('settings, warnings and cases survive restarting the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-manager-store-'));
  const path = join(directory, 'nested', 'bot.sqlite');
  let store = new Store(path);
  try {
    store.updateSettings('guild-a', { logChannelId: 'log-a', welcomeMessage: '你好 {user}' });
    const warning = store.addWarning({ guildId: 'guild-a', userId: 'user-a', moderatorId: 'mod-a', reason: '請遵守規則' });
    const action = store.addCase({ guildId: 'guild-a', userId: 'user-a', moderatorId: 'mod-a', action: 'warn', reason: '請遵守規則', details: `Warning #${warning.id}` });
    store.close();
    store = new Store(path);
    assert.equal(store.getSettings('guild-a').logChannelId, 'log-a');
    assert.equal(store.getSettings('guild-a').welcomeMessage, '你好 {user}');
    assert.equal(store.countWarnings('guild-a', 'user-a'), 1);
    assert.deepEqual({ ...store.listWarnings('guild-a', 'user-a')[0] }, warning);
    assert.deepEqual({ ...store.listCases('guild-a')[0] }, action);
    assert.ok(Number.isFinite(Date.parse(warning.createdAt)));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('guild settings and moderation history remain isolated', () => {
  const store = new Store(':memory:');
  try {
    store.updateSettings('guild-a', { welcomeChannelId: 'welcome-a', logChannelId: 'logs-a' });
    store.addWarning({ guildId: 'guild-a', userId: 'same-user', moderatorId: 'mod', reason: 'a' });
    store.addWarning({ guildId: 'guild-b', userId: 'same-user', moderatorId: 'mod', reason: 'b' });
    store.addWarning({ guildId: 'guild-a', userId: 'other-user', moderatorId: 'mod', reason: 'c' });
    store.addCase({ guildId: 'guild-a', action: 'clear', userId: null, moderatorId: 'mod', reason: 'a' });
    assert.equal(store.countWarnings('guild-a', 'same-user'), 1);
    assert.equal(store.listWarnings('guild-a', 'same-user')[0]?.reason, 'a');
    assert.equal(store.listWarnings('guild-b', 'same-user')[0]?.reason, 'b');
    assert.equal(store.countWarnings('guild-b', 'other-user'), 0);
    assert.equal(store.listCases('guild-b').length, 0);
    assert.deepEqual({ ...store.getSettings('guild-b') }, {
      guildId: 'guild-b', logChannelId: null, welcomeChannelId: null, welcomeMessage: DEFAULT_WELCOME_MESSAGE,
      appealChannelId: null, subareaCategoryId: null, subareaForumId: null,
      punishmentChannelId: null, punishmentNoticesEnabled: false, punishmentDmEnabled: true, punishmentIncludeSubareas: false,
      subareaNoticesEnabled: true,
    });
    store.updateSettings('guild-a', { logChannelId: null });
    assert.equal(store.getSettings('guild-a').logChannelId, null);
    assert.equal(store.getSettings('guild-a').welcomeChannelId, 'welcome-a');
  } finally {
    store.close();
  }
});

test('newest records come first and result limits are enforced', () => {
  const store = new Store(':memory:');
  try {
    const input = { guildId: 'guild', userId: 'user', moderatorId: 'mod', reason: 'first' };
    const first = store.addWarning(input);
    const second = store.addWarning({ ...input, reason: 'second' });
    store.addCase({ ...input, action: 'warn' });
    const lastCase = store.addCase({ ...input, action: 'timeout' });
    assert.deepEqual(store.listWarnings('guild', 'user').map((warning) => warning.id), [second.id, first.id]);
    assert.equal(store.listWarnings('guild', 'user', 1).length, 1);
    assert.equal(store.listCases('guild', 1)[0]?.id, lastCase.id);
    for (const invalid of [0, -1, 101, 1.5, Number.NaN]) {
      assert.throws(() => store.listWarnings('guild', 'user', invalid), RangeError);
      assert.throws(() => store.listCases('guild', invalid), RangeError);
    }
  } finally {
    store.close();
  }
});

test('bound parameters safely preserve SQL-looking text and invalid writes leave data intact', () => {
  const store = new Store(':memory:');
  try {
    const guildId = "guild'; DROP TABLE warnings; --";
    const reason = "請勿傳送 'spam'; DELETE FROM warnings; --";
    store.addWarning({ guildId, userId: 'user', moderatorId: 'mod', reason });
    assert.equal(store.listWarnings(guildId, 'user')[0]?.reason, reason);
    assert.equal(store.countWarnings('guild', 'user'), 0);
    assert.throws(() => store.addWarning({ guildId, userId: 'user', moderatorId: 'mod', reason: ' ' }), TypeError);
    assert.throws(() => store.updateSettings(guildId, { welcomeMessage: 'x'.repeat(2001) }), TypeError);
    assert.equal(store.countWarnings(guildId, 'user'), 1);
    assert.equal(store.getSettings(guildId).welcomeMessage, DEFAULT_WELCOME_MESSAGE);
  } finally {
    store.close();
  }
});
