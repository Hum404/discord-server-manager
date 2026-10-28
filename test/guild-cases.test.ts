import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/store.js';

const input = { userId: 'member', action: 'warn', moderatorId: 'moderator', reason: 'case reason' };

function databasePath(): { path: string; clean(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'discord-guild-cases-'));
  return { path: join(directory, 'cases.sqlite'), clean() { rmSync(directory, { recursive: true, force: true }); } };
}

test('public case numbers advance independently while internal keys remain unique across guilds', () => {
  const store = new Store(':memory:');
  try {
    const a1 = store.addCase({ ...input, guildId: 'guild-a' });
    const a2 = store.addCase({ ...input, guildId: 'guild-a' });
    const b1 = store.addCase({ ...input, guildId: 'guild-b' });
    const a3 = store.addCase({ ...input, guildId: 'guild-a' });
    assert.deepEqual([a1.caseNumber, a2.caseNumber, b1.caseNumber, a3.caseNumber], [1, 2, 1, 3]);
    assert.equal(new Set([a1.id, a2.id, b1.id, a3.id]).size, 4);
    assert.equal(store.getGuildCase('guild-b', 1)?.id, b1.id);
    assert.equal(store.getGuildCase('guild-a', 1)?.id, a1.id);
    assert.equal(store.getGuildCase('guild-b', 2), null);
    assert.equal(store.getGuildCase('guild-c', 1), null);
    assert.equal(store.getCase(b1.id)?.guildId, 'guild-b');
    assert.deepEqual(store.listCases('guild-a').map((item) => item.caseNumber), [3, 2, 1]);
    assert.equal(store.getSettings('guild-b').logChannelId, null);
  } finally { store.close(); }
});

test('local case lookups validate numbers and private lookups match only the exact applicant', () => {
  const store = new Store(':memory:');
  try {
    for (let index = 0; index < 105; index++) store.addCase({ ...input, guildId: `guild-${index}` });
    store.addCase({ ...input, guildId: 'private-other', userId: 'another-member' });
    const matches = store.findUserCasesByNumber('member', 1);
    assert.equal(matches.length, 105, 'ambiguous DM lookups must not silently truncate matching guilds');
    assert.ok(matches.every((item) => item.userId === 'member' && item.caseNumber === 1));
    assert.deepEqual(store.findUserCasesByNumber('member', 2), []);
    for (const value of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => store.getGuildCase('guild-0', value), RangeError);
      assert.throws(() => store.findUserCasesByNumber('member', value), RangeError);
    }
  } finally { store.close(); }
});

test('legacy migration backfills per-guild order without changing internal keys or appeal foreign keys', () => {
  const fixture = databasePath();
  const legacy = new DatabaseSync(fixture.path);
  legacy.exec(`
    CREATE TABLE moderation_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
      action TEXT NOT NULL, user_id TEXT, moderator_id TEXT NOT NULL, reason TEXT NOT NULL,
      details TEXT, created_at TEXT NOT NULL);
    INSERT INTO moderation_cases VALUES
      (11, 'guild-a', 'warn', 'member', 'mod', 'a1', NULL, '2026-01-01'),
      (24, 'guild-b', 'ban', 'member', 'mod', 'b1', NULL, '2026-01-02'),
      (48, 'guild-a', 'timeout', 'member', 'mod', 'a2', NULL, '2026-01-03');
    CREATE TABLE appeals (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
      case_id INTEGER NOT NULL REFERENCES moderation_cases(id), user_id TEXT NOT NULL,
      reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL,
      reviewer_id TEXT, response TEXT, reviewed_at TEXT, channel_id TEXT, message_id TEXT,
      UNIQUE(guild_id, case_id, user_id));
    INSERT INTO appeals VALUES (7, 'guild-b', 24, 'member', 'review b1', 'open', '2026-01-02', NULL, NULL, NULL, NULL, NULL);
  `);
  legacy.close();
  let store = new Store(fixture.path);
  try {
    assert.equal(store.getCase(11)?.caseNumber, 1);
    assert.equal(store.getCase(24)?.caseNumber, 1);
    assert.equal(store.getCase(48)?.caseNumber, 2);
    assert.equal(store.getAppeal(7)?.caseId, 24);
    assert.equal(store.getGuildCase('guild-b', 1)?.reason, 'b1');
    assert.equal(store.addCase({ ...input, guildId: 'guild-a' }).caseNumber, 3);
    const before = store.listCases('guild-a');
    store.close();
    store = new Store(fixture.path);
    assert.deepEqual(store.listCases('guild-a'), before);
    assert.equal(store.getAppeal(7)?.caseId, 24);
    assert.equal(store.addCase({ ...input, guildId: 'guild-b' }).caseNumber, 2);
    const check = new DatabaseSync(fixture.path);
    try { assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []); }
    finally { check.close(); }
  } finally { store.close(); fixture.clean(); }
});

test('a partial migration preserves existing public numbers and only assigns missing numbers', () => {
  const fixture = databasePath();
  const legacy = new DatabaseSync(fixture.path);
  legacy.exec(`
    CREATE TABLE moderation_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
      action TEXT NOT NULL, user_id TEXT, moderator_id TEXT NOT NULL, reason TEXT NOT NULL,
      details TEXT, created_at TEXT NOT NULL, case_number INTEGER);
    INSERT INTO moderation_cases VALUES
      (2, 'guild-a', 'warn', 'member', 'mod', 'keep a7', NULL, '2026-01-01', 7),
      (3, 'guild-b', 'warn', 'member', 'mod', 'new b1', NULL, '2026-01-02', NULL),
      (5, 'guild-a', 'warn', 'member', 'mod', 'new a8', NULL, '2026-01-03', NULL),
      (6, 'guild-a', 'warn', 'member', 'mod', 'new a9', NULL, '2026-01-04', NULL);
  `);
  legacy.close();
  let store = new Store(fixture.path);
  try {
    assert.deepEqual([2, 3, 5, 6].map((id) => store.getCase(id)?.caseNumber), [7, 1, 8, 9]);
    store.close();
    store = new Store(fixture.path);
    assert.deepEqual([2, 3, 5, 6].map((id) => store.getCase(id)?.caseNumber), [7, 1, 8, 9]);
    assert.equal(store.addCase({ ...input, guildId: 'guild-a' }).caseNumber, 10);
  } finally { store.close(); fixture.clean(); }
});

test('failed inserts roll back allocation and do not consume another guild sequence', () => {
  const fixture = databasePath();
  const store = new Store(fixture.path);
  const external = new DatabaseSync(fixture.path);
  try {
    assert.equal(store.addCase({ ...input, guildId: 'guild-a' }).caseNumber, 1);
    external.exec(`CREATE TRIGGER refuse_case BEFORE INSERT ON moderation_cases
      WHEN NEW.reason = 'refuse' BEGIN SELECT RAISE(ABORT, 'case refused'); END;`);
    assert.throws(() => store.addCase({ ...input, guildId: 'guild-a', reason: 'refuse' }), /case refused/);
    assert.throws(() => store.addCase({ ...input, guildId: 'guild-b', reason: 'refuse' }), /case refused/);
    assert.equal(store.addCase({ ...input, guildId: 'guild-a' }).caseNumber, 2);
    assert.equal(store.addCase({ ...input, guildId: 'guild-b' }).caseNumber, 1);
  } finally { external.close(); store.close(); fixture.clean(); }
});

test('case number exhaustion fails without unsafe integer rounding or a lingering transaction', () => {
  const fixture = databasePath();
  const store = new Store(fixture.path);
  const external = new DatabaseSync(fixture.path);
  try {
    external.prepare(`INSERT INTO moderation_cases(case_number, guild_id, action, user_id, moderator_id, reason, created_at)
      VALUES (?, 'guild-a', 'warn', 'member', 'mod', 'last safe case', '2026-01-01')`).run(Number.MAX_SAFE_INTEGER);
    assert.throws(() => store.addCase({ ...input, guildId: 'guild-a' }), RangeError);
    assert.equal(store.addCase({ ...input, guildId: 'guild-b' }).caseNumber, 1);
    assert.equal(store.listCases('guild-a').length, 1);
  } finally { external.close(); store.close(); fixture.clean(); }
});

test('concurrent bot processes allocate each guild sequence atomically', async () => {
  const fixture = databasePath();
  const initial = new Store(fixture.path);
  initial.close();
  let store: Store | undefined;
  const source = `
    import { Store } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};
    const store = new Store(process.argv[1]);
    try {
      for (let index = 0; index < 30; index++) {
        for (const guildId of ['guild-a', 'guild-b']) {
          store.addCase({ guildId, userId: 'member', action: 'warn', moderatorId: 'mod', reason: 'concurrent' });
        }
      }
    } finally { store.close(); }
  `;
  const run = () => new Promise<void>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, fixture.path],
      { cwd: new URL('..', import.meta.url), timeout: 30_000 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`Concurrent case writer failed: ${stderr}`, { cause: error }));
        else resolve();
      });
  });
  try {
    await Promise.all([run(), run()]);
    store = new Store(fixture.path);
    for (const guildId of ['guild-a', 'guild-b']) {
      assert.deepEqual(store.listCases(guildId, 100).map((item) => item.caseNumber),
        Array.from({ length: 60 }, (_unused, index) => 60 - index));
    }
  } finally { store?.close(); fixture.clean(); }
});
