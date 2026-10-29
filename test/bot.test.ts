import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, MessageFlags, PermissionFlagsBits, PermissionsBitField, type Interaction } from 'discord.js';
import { handleInteraction } from '../src/bot.js';
import { Store } from '../src/store.js';

const ids = {
  guild: '100000000000000001', actor: '100000000000000002', bot: '100000000000000003',
  target: '100000000000000004', channel: '100000000000000005', interaction: '100000000000000006',
  issuer: '100000000000000007', owner: '100000000000000008',
};
const fullPermissions = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers,
];

type Confirmation = 'confirm' | 'cancel' | 'timeout';
type MemberStub = { id: string; permissions: PermissionsBitField };
type Reply = { content?: string; embeds?: { toJSON(): { description?: string; footer?: { text: string }; fields?: Array<{ name: string; value: string }> } }[] };

/** Stub only Discord's transport boundary; real permission checks and SQLite run. */
function fixture(commandName: string, confirmation: Confirmation = 'confirm') {
  const edits: unknown[] = [];
  const deferOptions: unknown[] = [];
  const deletedSnapshots: string[][] = [];
  const fetchLimits: number[] = [];
  const actor = {
    id: ids.actor, permissions: new PermissionsBitField(fullPermissions), roles: { highest: { position: 10 } },
  };
  const issuer = {
    id: ids.issuer, permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
    roles: { highest: { position: 15 } },
  };
  const bot = {
    id: ids.bot, permissions: new PermissionsBitField(fullPermissions), roles: { highest: { position: 20 } },
  };
  const counters = { roleRefreshes: 0, actorRefreshes: 0, targetRefreshes: 0, issuerRefreshes: 0,
    notices: 0, kicks: 0, bans: 0, timeouts: 0 };
  const events: string[] = [];
  const state = { onConfirmation: () => {}, onNotify: () => {}, onKick: () => {}, onTargetFetch: (_refresh: number) => {} };
  const target = {
    id: ids.target, user: { id: ids.target, username: '測試成員', bot: false },
    guild: { id: ids.guild, name: '測試伺服器' },
    permissions: new PermissionsBitField(), roles: { highest: { position: 1 } },
    kickable: true, bannable: true, manageable: true,
    async send() { counters.notices += 1; events.push('notice'); state.onNotify(); },
    async kick() { counters.kicks += 1; events.push('kick'); state.onKick(); },
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
    isButton: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    inGuild: () => true,
    inCachedGuild: () => true,
    guild: {
      id: ids.guild, name: '測試伺服器', ownerId: ids.owner,
      roles: { async fetch() { counters.roleRefreshes += 1; } },
      members: {
        async fetch(options: { user: string; force: boolean }) {
          assert.equal(options.force, true);
          if (options.user === ids.actor) { counters.actorRefreshes += 1; return actor; }
          if (options.user === ids.issuer) { counters.issuerRefreshes += 1; return issuer; }
          assert.equal(options.user, ids.target);
          counters.targetRefreshes += 1;
          state.onTargetFetch(counters.targetRefreshes);
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
    actor, issuer, target, bot, counters, channel, messages, edits, deferOptions, deletedSnapshots, fetchLimits, state, events,
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

test('help uses consistent Traditional Chinese references in either Chinese Discord interface', async () => {
  const store = new Store(':memory:');
  try {
    for (const [locale, delegate, settings] of [
      ['zh-TW', '/子區 設定協管', '/設定 子區通知'],
      ['zh-CN', '/子區 設定協管', '/設定 子區通知'],
      ['en-US', '/subarea delegate', '/config subarea-notices'],
    ]) {
      const f = fixture('help');
      Object.assign(f.interaction, { locale });
      await handleInteraction(f.interaction, store);
      const text = f.finalReply().embeds?.[0]?.toJSON().fields?.map((field) => field.value).join('\n') ?? '';
      assert.ok(text.includes(delegate!));
      assert.ok(text.includes(settings!));
      if (locale !== 'en-US') assert.doesNotMatch(text, /\/(?:subarea|config|access|admin|appeal|records)\b/);
      assert.equal(f.counters.actorRefreshes, 0);
    }
    assert.deepEqual(store.listCases(ids.guild), []);
  } finally { store.close(); }
});

test('localized Discord command presentation retains canonical moderation routing and checks', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('warn');
    Object.assign(f.interaction, { locale: 'zh-CN' });
    await handleInteraction(f.interaction, store);
    assert.equal(store.listCases(ids.guild)[0]?.action, 'warn');
    assert.equal(store.countWarnings(ids.guild, ids.target), 1);
    f.actor.permissions.remove(PermissionFlagsBits.ModerateMembers);
    await handleInteraction(f.interaction, store);
    assert.equal(store.countWarnings(ids.guild, ids.target), 1);
    assert.match(f.finalReply().content ?? '', /沒有.*權限/);
  } finally { store.close(); }
});

test('Simplified ban entry follows confirmation, stores canonical cases and honors permission revocation', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('封禁');
    await handleInteraction(f.interaction, store);
    assert.equal(f.counters.bans, 1);
    assert.equal(store.listCases(ids.guild)[0]?.action, 'ban');
    assert.equal(store.listCases(ids.guild)[0]?.scope, 'server');
    assert.match(f.finalReply().content ?? '', /已封鎖/);
    const revoked = fixture('封禁');
    revoked.state.onConfirmation = () => revoked.actor.permissions.remove(PermissionFlagsBits.BanMembers);
    await handleInteraction(revoked.interaction, store);
    assert.equal(revoked.counters.bans, 0);
    assert.equal(revoked.counters.notices, 0);
    assert.equal(store.listCases(ids.guild).length, 1);
    assert.match(revoked.finalReply().content ?? '', /沒有.*權限/);
  } finally { store.close(); }
});

test('Simplified cleanup entry preserves scoped grants and channel permission checks', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('清理消息');
    f.actor.permissions.remove(PermissionFlagsBits.ManageMessages);
    store.setGrant(ids.guild, ids.actor, 'clear', ids.issuer);
    await handleInteraction(f.interaction, store);
    assert.equal(f.deletedSnapshots.length, 1);
    assert.equal(store.listCases(ids.guild)[0]?.action, 'clear');
    const denied = fixture('清理消息');
    denied.actor.permissions.remove([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory]);
    await handleInteraction(denied.interaction, store);
    assert.equal(denied.deletedSnapshots.length, 0);
    assert.match(denied.finalReply().content ?? '', /缺少查看頻道、讀取歷史/);
    assert.equal(store.listCases(ids.guild).length, 1);
  } finally { store.close(); }
});

test('Simplified configuration and permission administration entries cannot borrow moderation grants', async () => {
  const store = new Store(':memory:');
  try {
    for (const scope of ['warn', 'timeout', 'kick', 'ban', 'clear'] as const) store.setGrant(ids.guild, ids.actor, scope, ids.issuer);
    for (const alias of ['设置', '管理员', '管理授权']) {
      const f = fixture(alias);
      await handleInteraction(f.interaction, store);
      assert.match(f.finalReply().content ?? '', /沒有.*權限/);
      assert.equal(f.counters.targetRefreshes, 0);
    }
    assert.deepEqual(store.listCases(ids.guild), []);
  } finally { store.close(); }
});

test('Simplified child-area entry invokes the same owner-only authorization checks', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('子区');
    Object.assign(f.interaction, { locale: 'zh-CN' });
    Object.assign(f.channel, { guildId: ids.guild });
    Object.assign((f.interaction as unknown as { options: object }).options, {
      getSubcommand: () => 'pin', getChannel: () => null,
    });
    // The source is registered, but this caller is not its creator or delegate.
    store.setSubarea(ids.guild, ids.channel, ids.issuer);
    await handleInteraction(f.interaction, store);
    assert.match(f.finalReply().content ?? '', /只有目前子區建立者/);
    assert.doesNotMatch(f.finalReply().content ?? '', /找不到此指令/);
    assert.deepEqual(store.listCases(ids.guild), []);
  } finally { store.close(); }
});

test('Simplified child-area delegation executes once and sends a Traditional notice inside the area', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('子区');
    const notices: unknown[] = [];
    Object.assign(f.interaction, { locale: 'zh-CN' });
    Object.assign(f.channel, { guildId: ids.guild, async send(payload: unknown) { notices.push(payload); } });
    Object.assign((f.interaction as unknown as { options: object }).options, {
      getSubcommand: () => 'delegate', getChannel: () => null,
    });
    f.target.permissions.add(PermissionFlagsBits.ViewChannel);
    f.bot.permissions.add([PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.SendMessages]);
    store.setSubarea(ids.guild, ids.channel, ids.actor);
    await handleInteraction(f.interaction, store);
    assert.equal(store.getSubareaDelegate(ids.guild, ids.channel, ids.target)?.grantedBy, ids.actor);
    assert.equal(store.listCases(ids.guild).length, 1);
    assert.equal(store.listCases(ids.guild)[0]?.action, 'subarea-delegate');
    assert.equal(store.listServerCases(ids.guild).length, 0);
    assert.equal(notices.length, 1);
    assert.match(JSON.stringify(notices), /子區管理通知|授予子區協管/);
    assert.match(f.finalReply().content ?? '', /已授予/);
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

test('filtering every management notice retains punishment DMs, warning records and appealable cases', async () => {
  const store = new Store(':memory:');
  try {
    store.setNotificationActions(ids.guild, 'management', []);
    store.updateSettings(ids.guild, { logChannelId: ids.channel, punishmentChannelId: ids.channel, punishmentNoticesEnabled: true });
    const f = fixture('warn');
    await handleInteraction(f.interaction, store);
    assert.equal(f.counters.notices, 1, 'the pre-action DM remains controlled by its own setting');
    assert.equal(store.countWarnings(ids.guild, ids.target), 1);
    assert.equal(store.getGuildCase(ids.guild, 1)?.action, 'warn');
    assert.equal(store.getGuildCase(ids.guild, 1)?.userId, ids.target);
    assert.match(f.finalReply().content ?? '', /記錄警告/);
    assert.doesNotMatch(f.finalReply().content ?? '', /發送失敗/);
  } finally { store.close(); }
});

test('disabled punishment DMs skip delivery while completing moderation and keeping cases', async () => {
  const store = new Store(':memory:');
  try {
    store.updateSettings(ids.guild, { punishmentDmEnabled: false });
    for (const action of ['warn', 'timeout', 'kick', 'ban']) {
      const f = fixture(action);
      await handleInteraction(f.interaction, store);
      assert.equal(f.counters.notices, 0);
      assert.equal(store.listCases(ids.guild)[0]?.action, action);
      assert.doesNotMatch(f.finalReply().content ?? '', /無法私訊/);
      if (action === 'timeout') assert.equal(f.counters.timeouts, 1);
      if (action === 'kick') assert.equal(f.counters.kicks, 1);
      if (action === 'ban') assert.equal(f.counters.bans, 1);
    }
    assert.equal(store.listCases(ids.guild).length, 4);
    store.updateSettings(ids.guild, { punishmentDmEnabled: true });
    const resumed = fixture('warn');
    await handleInteraction(resumed.interaction, store);
    assert.equal(resumed.counters.notices, 1);
  } finally { store.close(); }
});

test('disabling DMs cannot bypass a grant revoked during the final target lookup', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('kick');
    f.actor.permissions.remove(PermissionFlagsBits.KickMembers);
    store.setGrant(ids.guild, ids.actor, 'kick', ids.issuer);
    store.updateSettings(ids.guild, { punishmentDmEnabled: false });
    // Initial lookup, post-confirmation lookup, and post-notification authority refresh.
    f.state.onTargetFetch = (count) => { if (count === 3) store.revokeGrant(ids.guild, ids.actor, 'kick'); };
    await handleInteraction(f.interaction, store);
    assert.equal(f.counters.notices, 0);
    assert.equal(f.counters.kicks, 0);
    assert.deepEqual(store.listCases(ids.guild), []);
    assert.match(f.finalReply().content ?? '', /授權.*撤回|授權.*變更/);
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

test('a delegated low-role member can warn an ordinary member using the active issuer authority', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('warn');
    f.actor.permissions.remove(PermissionFlagsBits.ModerateMembers);
    f.actor.roles.highest.position = f.target.roles.highest.position;
    store.setGrant(ids.guild, ids.actor, 'warn', ids.issuer);
    await handleInteraction(f.interaction, store);
    assert.equal(f.actor.permissions.has(PermissionFlagsBits.ModerateMembers), false);
    assert.equal(store.countWarnings(ids.guild, ids.target), 1);
    assert.equal(store.listCases(ids.guild)[0]?.moderatorId, ids.actor);
    assert.equal(f.counters.notices, 1);
    assert.ok(f.counters.issuerRefreshes >= 2);
    assert.match(f.finalReply().content ?? '', /記錄警告/);
  } finally { store.close(); }
});

for (const permission of [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild]) {
  test(`a management grant cannot punish a member protected by native permission ${permission}`, async () => {
    const store = new Store(':memory:');
    try {
      const f = fixture('warn');
      f.actor.permissions.remove(PermissionFlagsBits.ModerateMembers);
      f.target.permissions.add(permission);
      store.setGrant(ids.guild, ids.actor, 'warn', ids.issuer);
      await handleInteraction(f.interaction, store);
      assert.equal(store.countWarnings(ids.guild, ids.target), 0);
      assert.deepEqual(store.listCases(ids.guild), []);
      assert.equal(f.counters.notices, 0);
      assert.match(f.finalReply().content ?? '', /管理授權不能用來處罰伺服器管理員/);
    } finally { store.close(); }
  });
}

test('a delegated action still respects the current issuer role ceiling', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('warn');
    f.actor.permissions.remove(PermissionFlagsBits.ModerateMembers);
    f.target.roles.highest.position = f.issuer.roles.highest.position;
    store.setGrant(ids.guild, ids.actor, 'warn', ids.issuer);
    await handleInteraction(f.interaction, store);
    assert.equal(store.countWarnings(ids.guild, ids.target), 0);
    assert.equal(f.counters.notices, 0);
    assert.match(f.finalReply().content ?? '', /最高角色必須高於目標/);
  } finally { store.close(); }
});

test('a grant revoked while the appeal DM is being delivered prevents the punishment and case', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('kick');
    f.actor.permissions.remove(PermissionFlagsBits.KickMembers);
    store.setGrant(ids.guild, ids.actor, 'kick', ids.issuer);
    f.state.onNotify = () => { store.revokeGrant(ids.guild, ids.actor, 'kick'); };
    await handleInteraction(f.interaction, store);
    assert.deepEqual(f.events, ['notice']);
    assert.equal(f.counters.kicks, 0);
    assert.deepEqual(store.listCases(ids.guild), []);
    assert.match(f.finalReply().content ?? '', /沒有.*權限|授權.*撤回/);
  } finally { store.close(); }
});

test('a grant revoked during the final target refresh cannot authorize a kick', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('kick');
    f.actor.permissions.remove(PermissionFlagsBits.KickMembers);
    store.setGrant(ids.guild, ids.actor, 'kick', ids.issuer);
    f.state.onTargetFetch = (refresh) => {
      if (refresh === 3) store.revokeGrant(ids.guild, ids.actor, 'kick');
    };
    await handleInteraction(f.interaction, store);
    assert.equal(f.counters.notices, 1);
    assert.equal(f.counters.kicks, 0);
    assert.deepEqual(store.listCases(ids.guild), []);
    assert.match(f.finalReply().content ?? '', /沒有.*權限|授權.*撤回/);
  } finally { store.close(); }
});

test('a grant revoked after kick confirmation prevents even the punishment DM', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('kick');
    f.actor.permissions.remove(PermissionFlagsBits.KickMembers);
    store.setGrant(ids.guild, ids.actor, 'kick', ids.issuer);
    f.state.onConfirmation = () => { store.revokeGrant(ids.guild, ids.actor, 'kick'); };
    await handleInteraction(f.interaction, store);
    assert.equal(f.counters.notices, 0);
    assert.equal(f.counters.kicks, 0);
    assert.deepEqual(store.listCases(ids.guild), []);
    assert.match(f.finalReply().content ?? '', /沒有.*權限|授權.*撤回/);
  } finally { store.close(); }
});

test('a clear grant allows cleanup without native ManageMessages but unrelated grants do not', async () => {
  const store = new Store(':memory:');
  try {
    const allowed = fixture('clear');
    allowed.actor.permissions.remove(PermissionFlagsBits.ManageMessages);
    store.setGrant(ids.guild, ids.actor, 'clear', ids.issuer);
    await handleInteraction(allowed.interaction, store);
    assert.deepEqual(allowed.deletedSnapshots, [['recent-one', 'recent-two']]);
    assert.equal(store.listCases(ids.guild).length, 1);

    store.revokeGrant(ids.guild, ids.actor, 'clear');
    store.setGrant(ids.guild, ids.actor, 'warn', ids.issuer);
    const denied = fixture('clear');
    denied.actor.permissions.remove(PermissionFlagsBits.ManageMessages);
    await handleInteraction(denied.interaction, store);
    assert.deepEqual(denied.deletedSnapshots, []);
    assert.deepEqual(denied.fetchLimits, []);
    assert.equal(store.listCases(ids.guild).length, 1);
    assert.match(denied.finalReply().content ?? '', /沒有.*權限/);
  } finally { store.close(); }
});

for (const delegated of [false, true]) {
  for (const required of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) {
    test(`${delegated ? 'delegated' : 'native'} clear cannot operate without channel permission ${required}`, async () => {
      const store = new Store(':memory:');
      try {
        const f = fixture('clear');
        f.actor.permissions.remove(required);
        if (delegated) {
          f.actor.permissions.remove(PermissionFlagsBits.ManageMessages);
          store.setGrant(ids.guild, ids.actor, 'clear', ids.issuer);
        }
        await handleInteraction(f.interaction, store);
        assert.deepEqual(f.fetchLimits, []);
        assert.deepEqual(f.deletedSnapshots, []);
        assert.deepEqual(store.listCases(ids.guild), []);
        assert.match(f.finalReply().content ?? '', /缺少.*權限/);
      } finally { store.close(); }
    });
  }
}

test('the appeal DM is delivered before a kick and the case is recorded only after success', async (context) => {
  const store = new Store(':memory:');
  try {
    const f = fixture('kick');
    const addCase = store.addCase.bind(store);
    context.mock.method(store, 'addCase', (input: Parameters<Store['addCase']>[0]) => {
      f.events.push('case');
      assert.equal(f.counters.kicks, 1);
      return addCase(input);
    });
    f.state.onNotify = () => {
      assert.equal(f.counters.kicks, 0);
      assert.deepEqual(store.listCases(ids.guild), []);
    };
    f.state.onKick = () => { assert.deepEqual(store.listCases(ids.guild), []); };
    await handleInteraction(f.interaction, store);
    assert.deepEqual(f.events, ['notice', 'kick', 'case']);
    assert.equal(store.listCases(ids.guild)[0]?.action, 'kick');
    assert.match(f.finalReply().content ?? '', /已將.*踢出伺服器/);
  } finally { store.close(); }
});
