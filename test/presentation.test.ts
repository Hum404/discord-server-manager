import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatWelcome, recentMessageIds, truncate } from '../src/presentation.js';

const welcomeValues = {
  userId: '123456789012345678',
  serverName: '朋友的伺服器',
  memberCount: 42,
};

test('formats a complete welcome message and all repeated placeholders', () => {
  assert.equal(
    formatWelcome('歡迎 {user} 加入 {server}！你是第 {count} 位成員。{user}/{count}', welcomeValues),
    '歡迎 <@123456789012345678> 加入 朋友的伺服器！你是第 42 位成員。<@123456789012345678>/42',
  );
});

test('escapes server-name markdown without recursively expanding inserted placeholders', () => {
  assert.equal(
    formatWelcome('{server}，歡迎 {user}！', { ...welcomeValues, serverName: '**{user}** {count}' }),
    '\\*\\*{user}\\*\\* {count}，歡迎 <@123456789012345678>！',
  );
  assert.equal(formatWelcome('{unknown} / $&', welcomeValues), '{unknown} / $&');
});

test('welcome output stays within Discord limits after expanding every placeholder', () => {
  const result = formatWelcome('{user}'.repeat(150), welcomeValues);
  assert.equal(result.length, 2000);
  assert.ok(result.endsWith('…'));
  const emojiResult = formatWelcome('😀'.repeat(1001), welcomeValues);
  assert.equal(emojiResult, `${'😀'.repeat(999)}…`);
  assert.ok(emojiResult.length <= 2000);
  assert.equal(Buffer.from(emojiResult).toString(), emojiResult);
});

test('truncate preserves text at or below the limit and adds one ellipsis when clipping', () => {
  assert.equal(truncate('', 1), '');
  assert.equal(truncate('中文', 2), '中文');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abcdef', 1), '…');
});

test('truncate never cuts a surrogate pair at the clipping point', () => {
  assert.equal(truncate('a😀b', 3), 'a…');
  assert.equal(truncate('a😀bc', 4), 'a😀…');
  assert.equal(truncate('😀x', 2), '…');
  for (const limit of [1, 2, 3, 4, 5, 6]) {
    const result = truncate('😀😀😀x', limit);
    assert.ok(result.length <= limit);
    assert.equal(Buffer.from(result).toString(), result);
  }
});

test('truncate rejects invalid length limits', () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Infinity]) {
    assert.throws(() => truncate('text', limit), RangeError);
  }
});

test('message cleanup excludes old messages and the exact safety boundary', () => {
  const now = 1_800_000_000_000;
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;
  const boundary = now - fourteenDays + 5000;
  const messages = [
    { id: 'newest', createdTimestamp: now - 1000 },
    { id: 'exactly-fourteen-days', createdTimestamp: now - fourteenDays },
    { id: 'within-margin', createdTimestamp: boundary - 1 },
    { id: 'boundary', createdTimestamp: boundary },
    { id: 'recent-enough', createdTimestamp: boundary + 1 },
    { id: 'old', createdTimestamp: now - fourteenDays - 1 },
  ];
  assert.deepEqual(recentMessageIds(messages, now), ['newest', 'recent-enough']);
});

test('message cleanup accepts any iterable and preserves its order', () => {
  const now = 1_800_000_000_000;
  function* messages() {
    yield { id: 'second', createdTimestamp: now - 2000 };
    yield { id: 'first', createdTimestamp: now - 1000 };
  }
  assert.deepEqual(recentMessageIds(messages(), now), ['second', 'first']);
  assert.deepEqual(recentMessageIds([], now), []);
});
