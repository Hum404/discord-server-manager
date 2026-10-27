import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkModerationTarget, type ModerationTargetContext } from '../src/permissions.js';

const base: ModerationTargetContext = {
  actorId: 'actor',
  actorHighestPosition: 10,
  actorIsOwner: false,
  targetId: 'target',
  targetHighestPosition: 3,
  targetIsOwner: false,
  botId: 'bot',
  botHighestPosition: 8,
  action: 'kick',
  targetIsBot: false,
  targetIsAdministrator: false,
};

test('allows a valid target below both moderator and bot roles', () => {
  assert.equal(checkModerationTarget(base), null);
});

test('protects the actor, bot, and guild owner', () => {
  assert.match(checkModerationTarget({ ...base, targetId: 'actor' })!, /自己/);
  assert.match(checkModerationTarget({ ...base, targetId: 'bot' })!, /本機器人/);
  assert.match(checkModerationTarget({ ...base, targetIsOwner: true })!, /擁有者/);
});

test('blocks equal or higher actor roles even for permission-bearing moderators', () => {
  assert.match(checkModerationTarget({ ...base, actorHighestPosition: 3 })!, /你的最高角色/);
  assert.match(checkModerationTarget({ ...base, actorHighestPosition: 2 })!, /你的最高角色/);
});

test('guild owner bypasses the actor hierarchy but never the bot hierarchy', () => {
  assert.equal(checkModerationTarget({ ...base, actorIsOwner: true, actorHighestPosition: 1 }), null);
  assert.match(checkModerationTarget({
    ...base, actorIsOwner: true, targetHighestPosition: 8,
  })!, /機器人的最高角色/);
});

test('blocks bot hierarchy equality and higher roles for Discord actions', () => {
  for (const action of ['timeout', 'untimeout', 'kick', 'ban'] as const) {
    for (const targetHighestPosition of [8, 9]) {
      assert.match(checkModerationTarget({ ...base, action, targetHighestPosition })!, /機器人的最高角色/);
    }
  }
});

test('a stored warning requires moderator hierarchy but no bot role edit', () => {
  assert.equal(checkModerationTarget({ ...base, action: 'warn', targetHighestPosition: 9 }), null);
  assert.match(checkModerationTarget({ ...base, action: 'warn', targetHighestPosition: 10 })!, /你的最高角色/);
});

test('timeout rejects bots and administrators without blocking ordinary kicks or bans', () => {
  assert.match(checkModerationTarget({ ...base, action: 'timeout', targetIsBot: true })!, /機器人成員/);
  assert.match(checkModerationTarget({ ...base, action: 'untimeout', targetIsBot: true })!, /機器人成員/);
  assert.match(checkModerationTarget({ ...base, action: 'timeout', targetIsAdministrator: true })!, /管理員/);
  assert.equal(checkModerationTarget({ ...base, targetIsAdministrator: true }), null);
  assert.equal(checkModerationTarget({ ...base, action: 'ban', targetIsBot: true }), null);
});
