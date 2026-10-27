import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, MessageFlags, PermissionFlagsBits, PermissionsBitField, type Interaction } from 'discord.js';
import { handleInteraction } from '../src/bot.js';
import { Store } from '../src/store.js';

const ids = {
  guild: '100000000000000001', actor: '100000000000000002', bot: '100000000000000003',
  target: '100000000000000004', channel: '100000000000000005', interaction: '100000000000000006',
};
const fullPermissions = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers,
];

type Confirmation = 'confirm' | 'cancel' | 'timeout';
type MemberStub = { id: string; permissions: PermissionsBitField };
type Reply = { content?: string; embeds?: { toJSON(): { description?: string; footer?: { text: string } } }[] };

/** Stub only Discord's transport boundary; real permission checks and SQLite run. */
function fixture(commandName: string, confirmation: Confirmation = 'confirm') {
  const edits: unknown[] = [];
  const deferOptions: unknown[] = [];
  const deletedSnapshots: string[][] = [];
  const fetchLimits: number[] = [];
  const actor = {
    id: ids.actor, permissions: new PermissionsBitField(fullPermissions), roles: { highest: { position: 10 } },
  };
  const bot = {
    id: ids.bot, permissions: new PermissionsBitField(fullPermissions), roles: { highest: { position: 20 } },
  };
  const counters = { roleRefreshes: 0, actorRefreshes: 0, targetRefreshes: 0, kicks: 0, bans: 0, timeouts: 0 };
  const target = {
    id: ids.target, user: { id: ids.target, username: '測試成員', bot: false },
    permissions: new PermissionsBitField(), roles: { highest: { position: 1 } },
    kickable: true, bannable: true, manageable: true,
    async kick() { counters.kicks += 1; },
    async ban() { counters.bans += 1; },
    async timeout() { counters.timeouts += 1; },
  };
  const messages = new Map([
    ['recent-one', { id: 'recent-one', createdTimestamp: Date.now() - 60_000 }],
    ['recent-two', { id: 'recent-two', createdTimestamp: Date.now() - 120_000 }],
    ['too-old', { id: 'too-old', createdTimestamp: Date.now() - 15 * 24 * 60 * 60 * 1000 }],
  ]);
  const channel = {
    id: ids.channel, type: ChannelType.GuildText,
    permissionsFor(member: MemberStub) { return member.permissions; },
    messages: {
      async fetch(options: { limit: number }) {
        fetchLimits.push(options.limit);
        return new Map(messages);
      },
    },
    async bulkDelete(selected: string[], filterOld: boolean) {
      assert.equal(filterOld, true);
      deletedSnapshots.push([...selected]);
      return new Map(selected.map((id) => [id, messages.get(id)]));
    },
  };
  const state = { onConfirmation: () => {} };
  const message = {
    async awaitMessageComponent(options: { filter: (button: { user: { id: string }; customId: string }) => boolean }) {
      if (confirmation === 'timeout') throw { code: 'InteractionCollectorError' };
      const customId = `${confirmation}:${ids.interaction}`;
      assert.equal(options.filter({ user: { id: 'another-user' }, customId }), false);
      assert.equal(options.filter({ user: { id: ids.actor }, customId: 'unrelated-button' }), false);
      assert.equal(options.filter({ user: { id: ids.actor }, customId }), true);
      return {
        user: { id: ids.actor }, customId,
        async update(payload: unknown) {
          edits.push(payload);
          state.onConfirmation();
        },
      };
    },
  };
  const command = {
    id: ids.interaction, commandName, guildId: ids.guild, channelId: ids.channel,
    user: { id: ids.actor }, deferred: false, replied: false,
    isChatInputCommand: () => true,
    inCachedGuild: () => true,
    guild: {
      ownerId: 'owner',
      roles: { async fetch() { counters.roleRefreshes += 1; } },
      members: {
        async fetch(options: { user: string; force: boolean }) {
          assert.equal(options.force, true);
          if (options.user === ids.actor) { counters.actorRefreshes += 1; return actor; }
          assert.equal(options.user, ids.target);
          counters.targetRefreshes += 1;
          return target;
        },
        async fetchMe() { return bot; },
      },
      channels: { async fetch() { return channel; } },
    },
    options: {
      getUser: () => target.user,
      getString: () => '請遵守伺服器規則',
      getInteger: (name: string) => name === 'amount' ? 3 : name === 'minutes' ? 10 : 0,
    },
    async deferReply(options: unknown) { deferOptions.push(options); command.deferred = true; },
    async editReply(payload: unknown) { edits.push(payload); return message; },
    async reply(payload: unknown) { edits.push(payload); command.replied = true; },
  };
  return {
    interaction: command as unknown as Interaction,
    actor, counters, channel, messages, edits, deferOptions, deletedSnapshots, fetchLimits, state,
    finalReply: () => edits.at(-1) as Reply,
  };
}

test('warn rejects an actor without permission before writing a warning or case', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('warn');
    f.actor.permissions.remove(PermissionFlagsBits.ModerateMembers);
    await handleInteraction(f.interaction, store);
    assert.equal(store.countWarnings(ids.guild, ids.target), 0);
    assert.deepEqual(store.listCases(ids.guild), []);
    assert.equal(f.counters.targetRefreshes, 0);
    assert.match(f.finalReply().content ?? '', /沒有.*權限/);
  } finally { store.close(); }
});

test('warn persists its warning and moderation case and replies privately', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('warn');
    await handleInteraction(f.interaction, store);
    const warning = store.listWarnings(ids.guild, ids.target)[0];
    const action = store.listCases(ids.guild)[0];
    assert.ok(warning);
    assert.ok(action);
    assert.equal(warning.reason, '請遵守伺服器規則');
    assert.equal(warning.moderatorId, ids.actor);
    assert.equal(action.action, 'warn');
    assert.equal(action.userId, ids.target);
    assert.equal(action.moderatorId, ids.actor);
    assert.equal(store.countWarnings(ids.guild, ids.target), 1);
    assert.deepEqual(f.deferOptions, [{ flags: MessageFlags.Ephemeral }]);
    assert.match(f.finalReply().content ?? '', /記錄警告 #1.*累計 1 筆/);
    assert.match(f.finalReply().content ?? '', /案件 #1/);
  } finally { store.close(); }
});

test('warnings displays only records from the interaction guild', async () => {
  const store = new Store(':memory:');
  try {
    store.addWarning({ guildId: 'other-guild', userId: ids.target, moderatorId: ids.actor, reason: 'PRIVATEOTHERGUILD' });
    store.addWarning({ guildId: ids.guild, userId: ids.target, moderatorId: ids.actor, reason: 'VISIBLEHERE' });
    const f = fixture('warnings');
    await handleInteraction(f.interaction, store);
    const embed = f.finalReply().embeds?.[0]?.toJSON();
    assert.ok(embed);
    assert.match(embed.description ?? '', /VISIBLEHERE/);
    assert.doesNotMatch(embed.description ?? '', /PRIVATEOTHERGUILD/);
    assert.equal(embed.footer?.text, '共 1 筆，顯示最近 1 筆');
    assert.equal(store.listCases(ids.guild).length, 0);
  } finally { store.close(); }
});

for (const confirmation of ['cancel', 'timeout'] as const) {
  test(`clear ${confirmation} leaves messages and cases unchanged`, async () => {
    const store = new Store(':memory:');
    try {
      const f = fixture('clear', confirmation);
      await handleInteraction(f.interaction, store);
      assert.equal(f.deletedSnapshots.length, 0);
      assert.equal(store.listCases(ids.guild).length, 0);
      assert.equal(f.counters.actorRefreshes, 1);
      assert.match(f.finalReply().content ?? '', confirmation === 'cancel' ? /已取消/ : /逾時/);
    } finally { store.close(); }
  });
}

test('confirmed clear submits its original recent-message snapshot and records the requested count', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('clear');
    f.state.onConfirmation = () => {
      f.messages.set('arrived-during-confirmation', { id: 'arrived-during-confirmation', createdTimestamp: Date.now() });
    };
    await handleInteraction(f.interaction, store);
    assert.deepEqual(f.fetchLimits, [3]);
    assert.deepEqual(f.deletedSnapshots, [['recent-one', 'recent-two']]);
    assert.equal(f.counters.actorRefreshes, 2);
    assert.equal(f.counters.roleRefreshes, 2);
    const action = store.listCases(ids.guild)[0];
    assert.equal(action?.action, 'clear');
    assert.match(action?.details ?? '', /已送出刪除 2 則訊息的請求/);
    assert.match(f.finalReply().content ?? '', /本次送出 2 則訊息/);
  } finally { store.close(); }
});

test('clear rechecks channel permissions after confirmation and aborts if history access is revoked', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('clear');
    f.state.onConfirmation = () => { f.actor.permissions.remove(PermissionFlagsBits.ReadMessageHistory); };
    await handleInteraction(f.interaction, store);
    assert.equal(f.counters.actorRefreshes, 2);
    assert.equal(f.deletedSnapshots.length, 0);
    assert.equal(store.listCases(ids.guild).length, 0);
    assert.match(f.finalReply().content ?? '', /權限已變更.*未執行清理/);
  } finally { store.close(); }
});

test('kick rechecks actor permissions after confirmation and never acts when permission was revoked', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('kick');
    f.state.onConfirmation = () => { f.actor.permissions.remove(PermissionFlagsBits.KickMembers); };
    await handleInteraction(f.interaction, store);
    assert.equal(f.counters.actorRefreshes, 2);
    assert.equal(f.counters.targetRefreshes, 1);
    assert.equal(f.counters.kicks, 0);
    assert.equal(store.listCases(ids.guild).length, 0);
    assert.match(f.finalReply().content ?? '', /沒有.*權限/);
  } finally { store.close(); }
});

test('a completed kick is reported as completed when its local audit write fails', async (context) => {
  const store = new Store(':memory:');
  const errors = context.mock.method(console, 'error', () => {});
  context.mock.method(store, 'addCase', () => {
    throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
  });
  try {
    const f = fixture('kick');
    await handleInteraction(f.interaction, store);
    assert.equal(f.counters.kicks, 1);
    assert.equal(store.listCases(ids.guild).length, 0);
    assert.match(f.finalReply().content ?? '', /已將.*踢出伺服器/);
    assert.match(f.finalReply().content ?? '', /操作已完成，但本機管理紀錄寫入失敗/);
    assert.doesNotMatch(f.finalReply().content ?? '', /操作未能完成/);
    assert.equal(errors.mock.calls.length, 1);
  } finally { store.close(); }
});
