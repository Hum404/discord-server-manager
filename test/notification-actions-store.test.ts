import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  MANAGEMENT_NOTICE_ACTIONS, NOTICE_ACTION_LABELS, notificationActionsFor,
  SUBAREA_NOTICE_ACTIONS, type NoticeKind,
} from '../src/notification-actions.js';
import { Store } from '../src/store.js';

test('new guilds retain all current notification actions independently of delivery switches', () => {
  const store = new Store(':memory:');
  try {
    assert.deepEqual(store.getNotificationActions('guild-a', 'management'), MANAGEMENT_NOTICE_ACTIONS);
    assert.deepEqual(store.getNotificationActions('guild-a', 'subarea'), SUBAREA_NOTICE_ACTIONS);
    store.updateSettings('guild-a', {
      punishmentNoticesEnabled: false, punishmentDmEnabled: false,
      subareaNoticesEnabled: false, logChannelId: 'logs-a',
    });
    assert.deepEqual(store.getNotificationActions('guild-a', 'management'), MANAGEMENT_NOTICE_ACTIONS);
    assert.deepEqual(store.getNotificationActions('guild-a', 'subarea'), SUBAREA_NOTICE_ACTIONS);
    const detached = store.getNotificationActions('guild-a', 'subarea');
    detached.length = 0;
    assert.deepEqual(store.getNotificationActions('guild-a', 'subarea'), SUBAREA_NOTICE_ACTIONS);
    for (const kind of ['management', 'subarea'] as const) {
      const actions = notificationActionsFor(kind);
      assert.ok(actions.length <= 25, 'the entire selection fits in a Discord select menu');
      assert.equal(new Set(actions).size, actions.length);
      for (const action of actions) {
        assert.ok(NOTICE_ACTION_LABELS[action]);
        assert.equal(store.isNotificationActionEnabled('guild-a', kind, action), true);
      }
    }
  } finally { store.close(); }
});

test('custom selections and explicit none are isolated by guild and notice kind', () => {
  const store = new Store(':memory:');
  try {
    const originalSettings = store.getSettings('guild-a');
    assert.deepEqual(store.setNotificationActions('guild-a', 'management', ['ban', 'warn']), ['warn', 'ban']);
    assert.deepEqual(store.setNotificationActions('guild-a', 'subarea', []), []);
    assert.equal(store.isNotificationActionEnabled('guild-a', 'management', 'warn'), true);
    assert.equal(store.isNotificationActionEnabled('guild-a', 'management', 'timeout'), false);
    assert.equal(store.isNotificationActionEnabled('guild-a', 'subarea', 'subarea-delegate'), false);
    assert.deepEqual(store.getNotificationActions('guild-b', 'management'), MANAGEMENT_NOTICE_ACTIONS);
    assert.deepEqual(store.getNotificationActions('guild-b', 'subarea'), SUBAREA_NOTICE_ACTIONS);
    assert.deepEqual(store.getSettings('guild-a'), originalSettings);
    assert.deepEqual(store.listCases('guild-a'), [], 'configuration storage does not invent moderation cases');
    store.setNotificationActions('guild-a', 'management', MANAGEMENT_NOTICE_ACTIONS);
    assert.deepEqual(store.getNotificationActions('guild-a', 'management'), MANAGEMENT_NOTICE_ACTIONS);
    assert.deepEqual(store.getNotificationActions('guild-a', 'subarea'), []);
  } finally { store.close(); }
});

test('saved complete allowlists and none survive restart and unrelated setting changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-notification-actions-'));
  const path = join(directory, 'bot.sqlite');
  let store = new Store(path);
  try {
    store.setNotificationActions('guild-a', 'management', []);
    store.setNotificationActions('guild-a', 'subarea', ['subarea-delegate', 'subarea-mute']);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.getNotificationActions('guild-a', 'management'), []);
    assert.deepEqual(store.getNotificationActions('guild-a', 'subarea'), ['subarea-mute', 'subarea-delegate']);
    store.updateSettings('guild-a', { punishmentNoticesEnabled: true, subareaNoticesEnabled: false });
    store.close();
    store = new Store(path);
    assert.deepEqual(store.getNotificationActions('guild-a', 'management'), []);
    assert.deepEqual(store.getNotificationActions('guild-a', 'subarea'), ['subarea-mute', 'subarea-delegate']);
    assert.equal(store.isNotificationActionEnabled('guild-a', 'subarea', 'subarea-lock'), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('adding action preferences to an existing installation preserves history, appeal links and settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-notification-upgrade-'));
  const path = join(directory, 'bot.sqlite');
  let store = new Store(path);
  try {
    const settings = store.updateSettings('guild-a', {
      punishmentChannelId: 'existing-notice', logChannelId: 'existing-log',
      subareaNoticesEnabled: false, punishmentDmEnabled: false,
    });
    const warning = store.addWarning({ guildId: 'guild-a', userId: 'user-a', moderatorId: 'mod', reason: '舊警告' });
    const original = store.addCase({ guildId: 'guild-a', action: 'timeout', userId: 'user-a', moderatorId: 'mod', reason: '舊禁言' });
    const appeal = store.createAppeal({ guildId: 'guild-a', caseId: original.id, userId: 'user-a', reason: '舊申訴' });
    store.close();
    const old = new DatabaseSync(path);
    old.exec('DROP TABLE notification_action_settings');
    old.close();
    store = new Store(path);
    assert.deepEqual(store.getNotificationActions('guild-a', 'management'), MANAGEMENT_NOTICE_ACTIONS);
    assert.deepEqual(store.getNotificationActions('guild-a', 'subarea'), SUBAREA_NOTICE_ACTIONS);
    assert.deepEqual(store.getSettings('guild-a'), settings);
    assert.deepEqual({ ...store.getCase(original.id)! }, original);
    assert.deepEqual({ ...store.getAppeal(appeal.id)! }, { ...appeal });
    assert.deepEqual({ ...store.listWarnings('guild-a', 'user-a')[0]! }, warning);
    store.setNotificationActions('guild-a', 'management', ['timeout']);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.getNotificationActions('guild-a', 'management'), ['timeout']);
    assert.equal(store.getAppeal(appeal.id)?.caseId, original.id);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid selections cannot partially replace an existing allowlist', () => {
  const store = new Store(':memory:');
  try {
    store.setNotificationActions('guild-a', 'management', ['warn']);
    const invalidSelections: unknown[] = [
      null, {}, 'warn', false, ['warn', 'warn'], ['subarea-mute'], ['warn', 'unknown-action'],
      [1], ['warn', null], ["warn'); DROP TABLE moderation_cases; --"],
    ];
    for (const value of invalidSelections) {
      assert.throws(() => store.setNotificationActions('guild-a', 'management', value as readonly string[]), TypeError);
      assert.deepEqual(store.getNotificationActions('guild-a', 'management'), ['warn']);
    }
    for (const kind of ['server', '__proto__', '', null]) {
      assert.throws(() => store.setNotificationActions('guild-a', kind as NoticeKind, []), TypeError);
      assert.throws(() => store.getNotificationActions('guild-a', kind as NoticeKind), TypeError);
      assert.throws(() => notificationActionsFor(kind as NoticeKind), TypeError);
    }
    for (const guild of ['', ' ', 'x'.repeat(65)]) {
      assert.throws(() => store.setNotificationActions(guild, 'management', ['warn']), TypeError);
      assert.throws(() => store.getNotificationActions(guild, 'management'), TypeError);
    }
    assert.equal(store.isNotificationActionEnabled('guild-a', 'management', 'subarea-mute'), false);
    assert.equal(store.isNotificationActionEnabled('guild-a', 'subarea', 'warn'), false);
    assert.equal(store.isNotificationActionEnabled('guild-a', 'management', 'future-action'), false);
    assert.deepEqual(store.getNotificationActions('guild-a', 'management'), ['warn']);
  } finally { store.close(); }
});

test('bound guild identifiers and selections cannot alter a different guild or overwrite unrelated settings', () => {
  const store = new Store(':memory:');
  try {
    const guild = "guild-a'); DROP TABLE guild_settings; --";
    store.updateSettings('guild-a', { logChannelId: 'original-log' });
    store.setNotificationActions('guild-a', 'management', ['ban']);
    store.setNotificationActions(guild, 'management', ['warn']);
    assert.deepEqual(store.getNotificationActions(guild, 'management'), ['warn']);
    assert.deepEqual(store.getNotificationActions('guild-a', 'management'), ['ban']);
    assert.equal(store.getSettings('guild-a').logChannelId, 'original-log');
  } finally { store.close(); }
});

test('malformed persisted settings suppress delivery with a safe error rather than enabling all actions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-notification-corruption-'));
  const path = join(directory, 'bot.sqlite');
  let store = new Store(path);
  try {
    store.setNotificationActions('guild-a', 'management', ['warn']);
    store.close();
    const raw = new DatabaseSync(path);
    try {
      const update = raw.prepare('UPDATE notification_action_settings SET actions = ? WHERE guild_id = ? AND kind = ?');
      for (const corrupted of ['not-valid-json-private-data', '{"secret":"private-value"}', '["warn","warn"]', '["future-unknown-action"]']) {
        update.run(corrupted, 'guild-a', 'management');
        store = new Store(path);
        assert.throws(() => store.getNotificationActions('guild-a', 'management'), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, 'Stored notification action settings are invalid.');
          assert.ok(!error.message.includes(corrupted));
          return true;
        });
        assert.throws(() => store.isNotificationActionEnabled('guild-a', 'management', 'warn'), /settings are invalid/);
        assert.deepEqual(store.getNotificationActions('guild-b', 'management'), MANAGEMENT_NOTICE_ACTIONS);
        store.close();
      }
    } finally { raw.close(); }
    store = new Store(path);
    store.setNotificationActions('guild-a', 'management', []);
    assert.deepEqual(store.getNotificationActions('guild-a', 'management'), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
