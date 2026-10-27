import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MANAGEMENT_SCOPES } from '../src/domain.js';
import { Store, type SubareaRestriction } from '../src/store.js';

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function originalCase(store: Store, guildId = 'guild-a', userId = 'user-a', action = 'timeout') {
  return store.addCase({ guildId, userId, action, moderatorId: 'moderator', reason: '請遵守規則' });
}

test('migration preserves old settings/history and adds nullable feature settings on every reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-store-migrate-'));
  const path = join(directory, 'old.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY, log_channel_id TEXT,
      welcome_channel_id TEXT, welcome_message TEXT NOT NULL);
    INSERT INTO guild_settings VALUES ('guild-a', 'old-log', 'old-welcome', '原本的歡迎內容');
    CREATE TABLE moderation_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
      action TEXT NOT NULL, user_id TEXT, moderator_id TEXT NOT NULL, reason TEXT NOT NULL,
      details TEXT, created_at TEXT NOT NULL);
    INSERT INTO moderation_cases VALUES (1, 'guild-a', 'warn', 'user-a', 'mod', '舊警告', NULL, '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();
  let store = new Store(path);
  try {
    assert.deepEqual(plain(store.getSettings('guild-a')), {
      guildId: 'guild-a', logChannelId: 'old-log', welcomeChannelId: 'old-welcome',
      welcomeMessage: '原本的歡迎內容', appealChannelId: null, subareaCategoryId: null,
    });
    assert.equal(store.getCase(1)?.reason, '舊警告');
    store.updateSettings('guild-a', { appealChannelId: 'appeals', subareaCategoryId: 'areas' });
    store.close();
    store = new Store(path);
    assert.equal(store.getSettings('guild-a').logChannelId, 'old-log');
    assert.equal(store.getSettings('guild-a').appealChannelId, 'appeals');
    assert.equal(store.getSettings('guild-a').subareaCategoryId, 'areas');
    assert.equal(store.getCase(1)?.reason, '舊警告');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('grants isolate users/guilds, update issuers, and revoke one capability or all capabilities', () => {
  const store = new Store(':memory:');
  try {
    for (const scope of MANAGEMENT_SCOPES) store.setGrant('guild-a', 'user', scope, 'admin-a');
    store.setGrant('guild-b', 'user', 'ban', 'admin-b');
    store.setGrant('guild-a', 'other', 'warn', 'admin-a');
    assert.equal(store.listGrants('guild-a', 'user').length, 5);
    assert.equal(store.getGrant('guild-b', 'user', 'ban')?.grantedBy, 'admin-b');
    assert.equal(store.getGrant('guild-b', 'user', 'warn'), null);
    store.setGrant('guild-a', 'user', 'ban', 'new-admin');
    assert.equal(store.getGrant('guild-a', 'user', 'ban')?.grantedBy, 'new-admin');
    assert.equal(store.listGrants('guild-a', 'user').length, 5);
    assert.equal(store.revokeGrant('guild-a', 'user', 'ban'), 1);
    assert.equal(store.revokeGrant('guild-a', 'user', 'ban'), 0);
    assert.equal(store.revokeGrant('guild-a', 'user'), 4);
    assert.equal(store.listGrants('guild-a', 'user').length, 0);
    assert.equal(store.listGrants('guild-a', 'other').length, 1);
    assert.equal(store.getGrant('guild-b', 'user', 'ban')?.grantedBy, 'admin-b');
    assert.throws(() => store.setGrant('guild-a', 'user', 'admin' as never, 'mod'), TypeError);
  } finally {
    store.close();
  }
});

test('targeted case lookups support private user history without including other users', () => {
  const store = new Store(':memory:');
  try {
    const first = originalCase(store);
    const second = originalCase(store, 'guild-b');
    originalCase(store, 'guild-a', 'other-user');
    store.addCase({ guildId: 'guild-a', userId: null, action: 'clear', moderatorId: 'mod', reason: '清理' });
    assert.equal(store.getCase(first.id)?.userId, 'user-a');
    assert.equal(store.getCase(999), null);
    assert.deepEqual(store.listUserCases('user-a').map((entry) => entry.id), [second.id, first.id]);
    assert.deepEqual(store.listUserCases('user-a', 'guild-a').map((entry) => entry.id), [first.id]);
    assert.equal(store.listUserCases('user-a', undefined, 1).length, 1);
    assert.throws(() => store.getCase(0), RangeError);
    assert.throws(() => store.listUserCases('user-a', undefined, 101), RangeError);
  } finally {
    store.close();
  }
});

test('batch grants validate every capability first and rollback all writes if any database write fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-grants-atomic-'));
  const path = join(directory, 'bot.sqlite');
  const store = new Store(path);
  const control = new DatabaseSync(path);
  try {
    assert.equal(store.setGrants('guild-a', 'user', [...MANAGEMENT_SCOPES], 'admin').length, 5);
    assert.equal(store.listGrants('guild-a', 'user').length, 5);
    assert.throws(() => store.setGrants('guild-b', 'user', ['warn', 'invalid' as never], 'admin'), TypeError);
    assert.throws(() => store.setGrants('guild-b', 'user', [], 'admin'), TypeError);
    assert.throws(() => store.setGrants('guild-b', 'user', ['warn', 'warn'], 'admin'), TypeError);
    assert.equal(store.listGrants('guild-b', 'user').length, 0);
    control.exec(`CREATE TRIGGER fail_ban_grant BEFORE INSERT ON management_grants
      WHEN NEW.guild_id = 'guild-b' AND NEW.scope = 'ban'
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
    assert.throws(() => store.setGrants('guild-b', 'user', ['warn', 'timeout', 'ban'], 'admin'));
    assert.equal(store.listGrants('guild-b', 'user').length, 0);
    assert.equal(store.listGrants('guild-a', 'user').length, 5);
  } finally {
    control.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('appeal creation atomically enforces case ownership, guild, supported punishment and uniqueness', () => {
  const store = new Store(':memory:');
  try {
    const original = originalCase(store);
    const nonpunishment = originalCase(store, 'guild-a', 'user-a', 'unban');
    const shared = { guildId: 'guild-a', userId: 'user-a', reason: '我希望重新審查', caseId: original.id };
    assert.throws(() => store.createAppeal({ ...shared, guildId: 'guild-b' }), TypeError);
    assert.throws(() => store.createAppeal({ ...shared, userId: 'other-user' }), TypeError);
    assert.throws(() => store.createAppeal({ ...shared, caseId: nonpunishment.id }), TypeError);
    assert.throws(() => store.createAppeal({ ...shared, caseId: 999 }), TypeError);
    const appeal = store.createAppeal(shared);
    assert.equal(appeal.status, 'open');
    assert.equal(appeal.reviewerId, null);
    assert.equal(appeal.channelId, null);
    assert.equal(appeal.messageId, null);
    assert.equal(store.getAppealForCase('guild-b', original.id, 'user-a'), null);
    assert.equal(store.getAppealForCase('guild-a', original.id, 'other-user'), null);
    assert.equal(store.getAppealForCase('guild-a', original.id, 'user-a')?.id, appeal.id);
    assert.throws(() => store.createAppeal(shared));
    assert.equal(store.listAppeals('guild-a').length, 1);
    // A rejected transaction must not poison the connection for later valid writes.
    const next = originalCase(store, 'guild-a', 'user-a', 'subarea-kick');
    assert.equal(store.createAppeal({ ...shared, caseId: next.id }).status, 'open');
  } finally {
    store.close();
  }
});

test('appeal review is guild-scoped and only the first reviewer can close a ticket', () => {
  const store = new Store(':memory:');
  try {
    const original = originalCase(store);
    const appeal = store.createAppeal({ guildId: 'guild-a', caseId: original.id, userId: 'user-a', reason: '請審查' });
    assert.equal(store.reviewAppeal(appeal.id, 'guild-b', 'reviewer', 'accepted', '通過'), null);
    assert.equal(store.getAppeal(appeal.id)?.status, 'open');
    assert.throws(() => store.reviewAppeal(appeal.id, 'guild-a', 'reviewer', 'open' as never, 'invalid'), TypeError);
    assert.throws(() => store.reviewAppeal(appeal.id, 'guild-a', 'reviewer', 'accepted', ' '), TypeError);
    const reviewed = store.reviewAppeal(appeal.id, 'guild-a', 'reviewer-a', 'accepted', '證據不足，申訴通過');
    assert.equal(reviewed?.status, 'accepted');
    assert.equal(reviewed?.reviewerId, 'reviewer-a');
    assert.ok(reviewed?.reviewedAt && Number.isFinite(Date.parse(reviewed.reviewedAt)));
    assert.equal(store.reviewAppeal(appeal.id, 'guild-a', 'reviewer-b', 'rejected', '第二次審核'), null);
    assert.equal(store.getAppeal(appeal.id)?.response, '證據不足，申訴通過');
    assert.throws(() => store.createAppeal({ guildId: 'guild-a', caseId: original.id, userId: 'user-a', reason: '重複提交' }));
  } finally {
    store.close();
  }
});

test('appeal listings and message bindings preserve guild/user boundaries and ordering', () => {
  const store = new Store(':memory:');
  try {
    const own = originalCase(store);
    const otherGuild = originalCase(store, 'guild-b');
    const otherUser = originalCase(store, 'guild-a', 'other-user');
    const a = store.createAppeal({ guildId: 'guild-a', caseId: own.id, userId: 'user-a', reason: 'a' });
    const b = store.createAppeal({ guildId: 'guild-b', caseId: otherGuild.id, userId: 'user-a', reason: 'b' });
    const c = store.createAppeal({ guildId: 'guild-a', caseId: otherUser.id, userId: 'other-user', reason: 'c' });
    store.reviewAppeal(a.id, 'guild-a', 'reviewer', 'rejected', '駁回原因');
    assert.deepEqual(store.listAppeals('guild-a', 'open').map((entry) => entry.id), [c.id]);
    assert.deepEqual(store.listAppeals('guild-a', undefined, 'user-a').map((entry) => entry.id), [a.id]);
    assert.deepEqual(store.listUserAppeals('user-a').map((entry) => entry.id), [b.id, a.id]);
    assert.equal(store.listUserAppeals('user-a', 1)[0]?.id, b.id);
    assert.throws(() => store.setAppealMessage(a.id, 'guild-b', 'channel', 'message'), RangeError);
    store.setAppealMessage(a.id, 'guild-a', 'appeals-channel', 'appeal-message');
    assert.equal(store.getAppeal(a.id)?.channelId, 'appeals-channel');
    assert.equal(store.getAppeal(a.id)?.messageId, 'appeal-message');
    assert.equal(store.getAppeal(b.id)?.channelId, null);
  } finally {
    store.close();
  }
});

test('feature records, permission baselines and boolean restrictions survive a database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-feature-persist-'));
  const path = join(directory, 'bot.sqlite');
  let store = new Store(path);
  try {
    store.setGrant('guild-a', 'owner', 'ban', 'admin');
    store.setSubarea('guild-a', 'subarea', 'owner');
    const restriction: Omit<SubareaRestriction, 'updatedAt'> = {
      guildId: 'guild-a', channelId: 'subarea', userId: 'restricted-user', muted: true, kicked: false,
      originalAllow: '1024', originalDeny: '2048', moderatorId: 'owner', reason: '子區禁言',
    };
    store.setSubareaRestriction(restriction);
    const original = originalCase(store);
    const appeal = store.createAppeal({ guildId: 'guild-a', caseId: original.id, userId: 'user-a', reason: '請審查' });
    store.setAppealMessage(appeal.id, 'guild-a', 'staff-channel', 'message');
    store.close();
    store = new Store(path);
    assert.equal(store.getGrant('guild-a', 'owner', 'ban')?.grantedBy, 'admin');
    assert.equal(store.getSubarea('guild-a', 'subarea')?.ownerId, 'owner');
    const saved = store.getSubareaRestriction('guild-a', 'subarea', 'restricted-user')!;
    assert.equal(saved.muted, true);
    assert.equal(saved.kicked, false);
    assert.equal(saved.originalAllow, '1024');
    assert.equal(saved.originalDeny, '2048');
    assert.equal(store.getAppeal(appeal.id)?.messageId, 'message');
    assert.equal(store.getAppeal(appeal.id)?.status, 'open');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('subarea restrictions are isolated, layer flags, retain baselines, and cascade only from their parent', () => {
  const store = new Store(':memory:');
  try {
    const first = store.setSubarea('guild-a', 'channel', 'owner');
    store.setSubarea('guild-b', 'channel', 'different-owner');
    store.setSubarea('guild-a', 'other-channel', 'owner');
    const input: Omit<SubareaRestriction, 'updatedAt'> = {
      guildId: 'guild-a', channelId: 'channel', userId: 'user', muted: true, kicked: false,
      originalAllow: null, originalDeny: null, moderatorId: 'owner', reason: '子區規則',
    };
    store.setSubareaRestriction(input);
    store.setSubareaRestriction({ ...input, kicked: true });
    store.setSubareaRestriction({ ...input, guildId: 'guild-b', kicked: true });
    assert.equal(store.getSubareaRestriction('guild-a', 'channel', 'user')?.kicked, true);
    assert.equal(store.getSubareaRestriction('guild-a', 'channel', 'user')?.originalAllow, null);
    assert.equal(store.listSubareaRestrictions().length, 2);
    assert.equal(store.listSubareaRestrictions('guild-a').length, 1);
    assert.equal(store.listSubareas('guild-a', 'owner').length, 2);
    const reassigned = store.setSubarea('guild-a', 'channel', 'new-owner');
    assert.equal(reassigned.createdAt, first.createdAt);
    assert.equal(reassigned.ownerId, 'new-owner');
    assert.equal(store.getSubareaRestriction('guild-a', 'channel', 'user')?.muted, true);
    assert.throws(() => store.setSubareaRestriction({ ...input, guildId: 'unknown' }), TypeError);
    assert.throws(() => store.setSubareaRestriction({ ...input, originalAllow: '-1' }), TypeError);
    assert.throws(() => store.setSubareaRestriction({ ...input, muted: 1 as never }), TypeError);
    store.deleteSubarea('guild-a', 'channel');
    assert.equal(store.getSubareaRestriction('guild-a', 'channel', 'user'), null);
    assert.equal(store.getSubareaRestriction('guild-b', 'channel', 'user')?.kicked, true);
    assert.equal(store.getSubarea('guild-a', 'other-channel')?.ownerId, 'owner');
    store.deleteSubareaRestriction('guild-b', 'channel', 'user');
    assert.equal(store.listSubareaRestrictions().length, 0);
  } finally {
    store.close();
  }
});
