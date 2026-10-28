import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { auditScopeForAction, SERVER_AUDIT_ACTIONS } from '../src/audit-policy.js';
import { Store, type MemberRecordDirection } from '../src/store.js';

const input = { guildId: 'guild-a', moderatorId: 'alice', userId: 'bob', reason: 'operation reason' };

test('only exact guild sanction names enter the server ledger', () => {
  const store = new Store(':memory:');
  try {
    for (const action of SERVER_AUDIT_ACTIONS) {
      assert.equal(auditScopeForAction(action), 'server');
      assert.equal(store.addCase({ ...input, action }).scope, 'server');
    }
    for (const action of ['subarea-kick', 'subarea-unkick', 'subarea-mute', 'subarea-unmute',
      'subarea-create', 'subarea-assign', 'subarea-pin', 'subarea-unpin', 'subarea-delete-message',
      'subarea-lock', 'subarea-unlock', 'subarea-delete', 'subarea-slowmode', 'subarea-rename',
      'subarea-delegate', 'subarea-undelegate', 'subarea-tag', 'subarea-announce', 'subarea-role-tag',
      'message-pin', 'message-unpin', 'message-delete', 'clear', 'config', 'role-add', 'role-remove',
      'channel-edit', 'access-grant', 'access-revoke', 'appeal-submit', 'appeal-review', 'future-action',
      'timeout-extra', 'KICK']) {
      assert.equal(auditScopeForAction(action), 'member', action);
      assert.equal(store.addCase({ ...input, action }).scope, 'member', action);
    }
    assert.deepEqual(store.listServerCases('guild-a', undefined, 100).map((item) => item.action), [...SERVER_AUDIT_ACTIONS].reverse());
    assert.equal(store.listMemberCases('guild-a', 'alice', 'performed', 100).some((item) => item.action === 'kick'), false);
  } finally { store.close(); }
});

test('member records isolate the guild and distinguish performed and received operations', () => {
  const store = new Store(':memory:');
  try {
    const performed = store.addCase({ ...input, action: 'subarea-mute', channelId: 'area-a' });
    const received = store.addCase({ ...input, action: 'subarea-kick', moderatorId: 'carol', userId: 'alice' });
    const self = store.addCase({ ...input, action: 'subarea-create', userId: 'alice' });
    store.addCase({ ...input, action: 'kick' });
    store.addCase({ ...input, action: 'subarea-mute', guildId: 'guild-b' });
    store.addCase({ ...input, action: 'subarea-mute', moderatorId: 'carol' });
    assert.deepEqual(store.listMemberCases('guild-a', 'alice').map((item) => item.id), [self.id, performed.id]);
    assert.deepEqual(store.listMemberCases('guild-a', 'alice', 'received').map((item) => item.id), [self.id, received.id]);
    assert.deepEqual(store.listMemberCases('guild-a', 'alice', 'all').map((item) => item.id), [self.id, received.id, performed.id]);
    assert.equal(store.listMemberCases('guild-a', 'alice', 'all', 1)[0]?.id, self.id);
    assert.equal(store.getMemberCase('guild-a', performed.caseNumber, 'alice')?.channelId, 'area-a');
    assert.equal(store.getMemberCase('guild-a', performed.caseNumber, 'bob', 'received')?.id, performed.id);
    assert.equal(store.getMemberCase('guild-a', performed.caseNumber, 'bob'), null);
    assert.equal(store.getMemberCase('guild-b', performed.caseNumber, 'alice')?.guildId, 'guild-b');
    assert.equal(store.getMemberCase('guild-c', performed.caseNumber, 'alice'), null);
    assert.equal(store.getMemberCase('guild-a', received.caseNumber, 'alice'), null);
    assert.equal(store.getMemberCase('guild-a', received.caseNumber, 'alice', 'all')?.id, received.id);
  } finally { store.close(); }
});

test('server queries filter their target without exposing member operations or another guild', () => {
  const store = new Store(':memory:');
  try {
    const a = store.addCase({ ...input, action: 'timeout' });
    const b = store.addCase({ ...input, action: 'ban', userId: 'alice' });
    const member = store.addCase({ ...input, action: 'subarea-kick' });
    store.addCase({ ...input, action: 'ban', guildId: 'guild-b' });
    assert.deepEqual(store.listServerCases('guild-a').map((item) => item.id), [b.id, a.id]);
    assert.deepEqual(store.listServerCases('guild-a', 'bob').map((item) => item.id), [a.id]);
    assert.equal(store.getServerCase('guild-a', a.caseNumber)?.id, a.id);
    assert.equal(store.getServerCase('guild-a', member.caseNumber), null);
    assert.equal(store.getMemberCase('guild-a', a.caseNumber, 'alice'), null);
    assert.equal(store.getGuildCase('guild-a', member.caseNumber)?.id, member.id, 'internal case lookup remains scope-neutral');
  } finally { store.close(); }
});

test('member query directions, limits and identifiers are validated and safely bound', () => {
  const store = new Store(':memory:');
  try {
    const unusual = "alice' OR 1=1 --";
    const record = store.addCase({ ...input, action: 'subarea-pin', moderatorId: unusual });
    assert.equal(store.listMemberCases('guild-a', unusual)[0]?.id, record.id);
    assert.deepEqual(store.listMemberCases('guild-a', 'alice'), []);
    const invalid = 'performed OR 1=1' as MemberRecordDirection;
    assert.throws(() => store.listMemberCases('guild-a', 'alice', invalid), TypeError);
    assert.throws(() => store.getMemberCase('guild-a', 1, 'alice', invalid), TypeError);
    for (const limit of [0, -1, 101, NaN, 1.5]) {
      assert.throws(() => store.listServerCases('guild-a', undefined, limit), RangeError);
      assert.throws(() => store.listMemberCases('guild-a', 'alice', 'all', limit), RangeError);
    }
    assert.throws(() => store.listMemberCases('', 'alice'), TypeError);
    assert.throws(() => store.getMemberCase('guild-a', 0, 'alice'), RangeError);
    assert.throws(() => store.getServerCase('guild-a', 0), RangeError);
  } finally { store.close(); }
});

test('scope is derived rather than trusted and invalid channel metadata never consumes a number', () => {
  const store = new Store(':memory:');
  try {
    const spoof = { ...input, action: 'subarea-kick', scope: 'server', channelId: 'area-a' };
    const record = store.addCase(spoof);
    assert.equal(record.scope, 'member');
    assert.equal(store.getServerCase('guild-a', record.caseNumber), null);
    assert.throws(() => store.addCase({ ...input, action: 'subarea-lock', channelId: '' }), TypeError);
    assert.throws(() => store.addCase({ ...input, action: 'subarea-lock', channelId: 'a'.repeat(65) }), TypeError);
    assert.equal(store.addCase({ ...input, action: 'timeout' }).caseNumber, 2);
    assert.equal(store.addCase({ ...input, action: 'subarea-pin', guildId: 'guild-b' }).caseNumber, 1);
  } finally { store.close(); }
});

test('member history remains immutable after its subarea is deleted', () => {
  const store = new Store(':memory:');
  try {
    store.setSubarea('guild-a', 'area-a', 'alice');
    const record = store.addCase({ ...input, action: 'subarea-delete', channelId: 'area-a' });
    store.deleteSubarea('guild-a', 'area-a');
    assert.deepEqual({ ...store.getMemberCase('guild-a', record.caseNumber, 'alice')! }, record);
    assert.equal(store.listServerCases('guild-a').length, 0);
  } finally { store.close(); }
});

test('legacy scope migration preserves identifiers, case numbers and appeal foreign keys across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-member-ledger-'));
  const path = join(directory, 'bot.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE moderation_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, case_number INTEGER,
      guild_id TEXT NOT NULL, action TEXT NOT NULL, user_id TEXT, moderator_id TEXT NOT NULL,
      reason TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL);
    INSERT INTO moderation_cases VALUES
      (11, 7, 'guild-a', 'subarea-kick', 'bob', 'alice', 'local sanction', '子區 123456789012345678', '2026-01-01'),
      (18, 9, 'guild-a', 'warn', 'bob', 'admin', 'server sanction', NULL, '2026-01-02'),
      (37, 1, 'guild-b', 'timeout', 'bob', 'admin', 'other guild sanction', NULL, '2026-01-03');
    CREATE TABLE appeals (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
      case_id INTEGER NOT NULL REFERENCES moderation_cases(id), user_id TEXT NOT NULL,
      reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL,
      reviewer_id TEXT, response TEXT, reviewed_at TEXT, channel_id TEXT, message_id TEXT,
      UNIQUE(guild_id, case_id, user_id));
    INSERT INTO appeals VALUES (4, 'guild-a', 11, 'bob', 'appeal local sanction', 'open', '2026-01-01', NULL, NULL, NULL, NULL, NULL);
  `);
  legacy.close();
  let store = new Store(path);
  try {
    const member = store.getCase(11)!;
    assert.equal(member.scope, 'member'); assert.equal(member.caseNumber, 7);
    assert.equal(member.channelId, '123456789012345678');
    assert.equal(store.getCase(18)?.scope, 'server');
    assert.equal(store.getAppeal(4)?.caseId, 11);
    assert.deepEqual(store.listServerCases('guild-a').map((item) => item.id), [18]);
    assert.equal(store.listMemberCases('guild-a', 'alice')[0]?.id, 11);
    store.close(); store = new Store(path);
    assert.deepEqual({ ...store.getCase(11)! }, { ...member });
    assert.equal(store.getAppeal(4)?.caseId, 11);
    assert.equal(store.addCase({ ...input, action: 'subarea-pin' }).caseNumber, 10);
    assert.equal(store.addCase({ ...input, action: 'ban', guildId: 'guild-b' }).caseNumber, 2);
    const check = new DatabaseSync(path);
    try {
      assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
      const indexes = check.prepare('PRAGMA index_list(moderation_cases)').all() as Array<{ name: string }>;
      for (const name of ['cases_scope_guild', 'cases_member_actor', 'cases_member_target']) {
        assert.ok(indexes.some((index) => index.name === name));
      }
    } finally { check.close(); }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('partially migrated rows are classified without rewriting existing public references', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-member-partial-'));
  const path = join(directory, 'bot.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE moderation_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, case_number INTEGER,
      guild_id TEXT NOT NULL, action TEXT NOT NULL, user_id TEXT, moderator_id TEXT NOT NULL,
      reason TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL, scope TEXT, channel_id TEXT);
    INSERT INTO moderation_cases VALUES
      (14, 11, 'guild-a', 'subarea-lock', NULL, 'alice', 'keep saved member scope', NULL, '2026-01-01', 'member', 'existing-area'),
      (18, 12, 'guild-a', 'ban', 'bob', 'admin', 'classify pending server row', NULL, '2026-01-02', NULL, NULL);
  `);
  legacy.close();
  const store = new Store(path);
  try {
    assert.equal(store.getCase(14)?.channelId, 'existing-area');
    assert.equal(store.getCase(14)?.caseNumber, 11);
    assert.equal(store.getCase(18)?.scope, 'server');
    assert.equal(store.getCase(18)?.caseNumber, 12);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
