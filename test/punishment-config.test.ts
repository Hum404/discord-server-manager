import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChannelType, PermissionFlagsBits as P, PermissionsBitField,
  type ChatInputCommandInteraction, type EmbedBuilder,
} from 'discord.js';
import { handlePunishmentConfig, parsePunishmentChannel } from '../src/punishment-config.js';
import { Store } from '../src/store.js';

const id = {
  guild: '870000000000000001', actor: '870000000000000002', owner: '870000000000000003',
  bot: '870000000000000004', invocation: '870000000000000005', notice: '870000000000000006',
  alternate: '870000000000000007', otherGuild: '870000000000000008', otherUser: '870000000000000009',
};
type Payload = { content?: string; embeds?: EmbedBuilder[]; allowedMentions?: unknown };

function fixture() {
  const state = {
    subcommand: 'punishments', selected: null as string | null, channelId: null as string | null,
    enabled: null as boolean | null, dm: null as boolean | null, includeSubareas: null as boolean | null,
    onChannel: () => {}, onMember: () => {},
  };
  const actor = { id: id.actor, permissions: new PermissionsBitField(P.ManageGuild) };
  const bot = { id: id.bot, permissions: new PermissionsBitField(P.Administrator) };
  const replies: Payload[] = [];
  const sent: Array<{ channelId: string; payload: Payload }> = [];
  const fetched: string[] = [];
  const guild = {
    id: id.guild, ownerId: id.owner,
    roles: { async fetch() {} },
    members: {
      async fetch(options: { user: string; force: boolean }) {
        assert.equal(options.user, actor.id); assert.equal(options.force, true); state.onMember(); return actor;
      },
      async fetchMe(options: { force: boolean }) { assert.equal(options.force, true); return bot; },
    },
    channels: { async fetch(channelId: string, options: { force: boolean }) {
      assert.equal(options.force, true); fetched.push(channelId); state.onChannel();
      return channels.get(channelId) ?? null;
    } },
  };
  function makeChannel(channelId: string) {
    return {
      id: channelId, guildId: id.guild, guild, type: ChannelType.GuildText as ChannelType,
      archived: false, locked: false,
      permissionsFor: () => bot.permissions,
      async send(payload: Payload) { sent.push({ channelId, payload }); },
    };
  }
  const channel = makeChannel(id.notice);
  const alternate = makeChannel(id.alternate);
  const channels = new Map([[channel.id, channel], [alternate.id, alternate]]);
  const command = {
    guildId: id.guild, channelId: id.invocation, guild, user: { id: id.actor },
    options: {
      getSubcommand: () => state.subcommand,
      getChannel: () => state.selected === null ? null : { id: state.selected },
      getString: () => state.channelId,
      getBoolean: (name: string) => name === 'enabled' ? state.enabled
        : name === 'dm' ? state.dm : state.includeSubareas,
    },
    async editReply(payload: Payload) { replies.push(payload); },
  } as unknown as ChatInputCommandInteraction<'cached'>;
  return { state, actor, bot, guild, channel, alternate, channels, command, replies, sent, fetched,
    output: () => JSON.stringify(replies.map((reply) => ({ ...reply,
      embeds: reply.embeds?.map((embed) => embed.toJSON()),
    }))),
  };
}

function withStore(run: (store: Store) => Promise<void>) {
  return async () => { const store = new Store(':memory:'); try { await run(store); } finally { store.close(); } };
}

test('native managers, administrators and guild owners may configure their own guild', withStore(async (store) => {
  for (const authority of ['manager', 'administrator', 'owner']) {
    const f = fixture(); f.state.dm = false;
    if (authority === 'administrator') f.actor.permissions = new PermissionsBitField(P.Administrator);
    if (authority === 'owner') { f.actor.permissions = new PermissionsBitField(); f.guild.ownerId = id.actor; }
    await handlePunishmentConfig(f.command, store);
    assert.equal(store.getSettings(id.guild).punishmentDmEnabled, false);
    assert.match(f.output(), /已更新/);
    assert.deepEqual(f.sent, []);
    store.updateSettings(id.guild, { punishmentDmEnabled: true });
  }
}));

test('delegated moderation and local ownership never permit configuring public notices', withStore(async (store) => {
  for (const scope of ['warn', 'timeout', 'kick', 'ban', 'clear'] as const) {
    store.setGrant(id.guild, id.actor, scope, id.owner);
  }
  store.setSubarea(id.guild, id.invocation, id.actor);
  const f = fixture(); f.actor.permissions = new PermissionsBitField(); f.state.selected = id.notice;
  await assert.rejects(handlePunishmentConfig(f.command, store), /原生.*管理伺服器/);
  assert.equal(store.getSettings(id.guild).punishmentChannelId, null);
  assert.deepEqual(store.listCases(id.guild), []);
  assert.deepEqual(f.fetched, []); assert.deepEqual(f.sent, []); assert.deepEqual(f.replies, []);
}));

test('viewing notice settings remains private, scoped to this guild and free of writes', withStore(async (store) => {
  store.updateSettings(id.guild, { punishmentChannelId: id.notice, punishmentDmEnabled: false });
  store.updateSettings(id.otherGuild, { punishmentChannelId: id.alternate, punishmentNoticesEnabled: true });
  const f = fixture(); await handlePunishmentConfig(f.command, store);
  assert.match(f.output(), new RegExp(id.notice));
  assert.doesNotMatch(f.output(), new RegExp(id.alternate));
  assert.deepEqual(f.replies[0]?.allowedMentions, { parse: [] });
  assert.deepEqual(f.fetched, []); assert.deepEqual(f.sent, []);
  assert.deepEqual(store.listCases(id.guild), []);
}));

test('choosing a new notice destination enables it while preserving other settings and ledger privacy', withStore(async (store) => {
  store.updateSettings(id.guild, {
    logChannelId: id.alternate, punishmentDmEnabled: false, punishmentIncludeSubareas: true,
    welcomeChannelId: id.invocation,
  });
  const foreignBefore = store.getSettings(id.otherGuild);
  const f = fixture(); f.state.selected = id.notice;
  await handlePunishmentConfig(f.command, store);
  const settings = store.getSettings(id.guild);
  assert.equal(settings.punishmentChannelId, id.notice);
  assert.equal(settings.punishmentNoticesEnabled, true);
  assert.equal(settings.punishmentDmEnabled, false);
  assert.equal(settings.punishmentIncludeSubareas, true);
  assert.equal(settings.logChannelId, id.alternate);
  assert.equal(settings.welcomeChannelId, id.invocation);
  assert.deepEqual(store.getSettings(id.otherGuild), foreignBefore);
  assert.deepEqual(f.fetched, [id.notice]); assert.deepEqual(f.sent, []);
  const change = store.listCases(id.guild)[0]!;
  assert.equal(change.action, 'config'); assert.equal(change.scope, 'member');
  assert.equal(change.moderatorId, id.actor);
}));

test('channel-ID and same-guild message links select actual thread destinations', withStore(async (store) => {
  for (const value of [id.alternate, `https://discord.com/channels/${id.guild}/${id.alternate}`,
    `https://canary.discord.com/channels/${id.guild}/${id.alternate}/870000000000000010`]) {
    const f = fixture(); f.state.channelId = value; f.alternate.type = ChannelType.PublicThread;
    await handlePunishmentConfig(f.command, store);
    assert.equal(store.getSettings(id.guild).punishmentChannelId, id.alternate);
    assert.deepEqual(f.fetched, [id.alternate]); assert.deepEqual(f.sent, []);
  }
}));

test('invalid links and conflicting targets cannot alter settings or disclose content to a destination', withStore(async (store) => {
  const original = store.getSettings(id.guild);
  const badValues = [
    '123', 'not-a-channel', `https://discord.com/channels/${id.otherGuild}/${id.notice}`,
    `https://discord.com.evil.example/channels/${id.guild}/${id.notice}`,
    `http://discord.com/channels/${id.guild}/${id.notice}`,
    `https://discord.com@evil.example/channels/${id.guild}/${id.notice}`,
    `https://evil.example@discord.com/channels/${id.guild}/${id.notice}`,
    `https://discord.com:8443/channels/${id.guild}/${id.notice}`,
    `https://discord.com/channels/@me/${id.notice}`,
  ];
  for (const value of badValues) {
    assert.throws(() => parsePunishmentChannel(value, id.guild), /本伺服器/);
    const f = fixture(); f.state.channelId = value;
    await assert.rejects(handlePunishmentConfig(f.command, store), /本伺服器/);
    assert.deepEqual(f.fetched, []); assert.deepEqual(f.sent, []);
  }
  const conflicting = fixture(); conflicting.state.selected = id.notice; conflicting.state.channelId = id.alternate;
  await assert.rejects(handlePunishmentConfig(conflicting.command, store), /只填寫其中一項/);
  assert.deepEqual(conflicting.fetched, []);
  assert.deepEqual(store.getSettings(id.guild), original);
  assert.deepEqual(store.listCases(id.guild), []);
}));

test('foreign, missing and non-message destinations are rejected without persisting them', withStore(async (store) => {
  for (const bad of ['foreign', 'forum', 'category', 'missing', 'archived', 'locked']) {
    const f = fixture(); f.state.selected = id.notice;
    if (bad === 'foreign') f.channel.guildId = id.otherGuild;
    if (bad === 'forum') f.channel.type = ChannelType.GuildForum;
    if (bad === 'category') f.channel.type = ChannelType.GuildCategory;
    if (bad === 'missing') f.channels.delete(id.notice);
    if (bad === 'archived') { f.channel.type = ChannelType.PublicThread; f.channel.archived = true; }
    if (bad === 'locked') { f.channel.type = ChannelType.PublicThread; f.channel.locked = true; }
    await assert.rejects(handlePunishmentConfig(f.command, store));
    assert.equal(store.getSettings(id.guild).punishmentChannelId, null);
    assert.deepEqual(f.sent, []); assert.deepEqual(store.listCases(id.guild), []);
  }
}));

test('disabling notices and DM-only changes work after a destination is deleted', withStore(async (store) => {
  store.updateSettings(id.guild, { punishmentChannelId: id.notice, punishmentNoticesEnabled: true });
  const dm = fixture(); dm.channels.clear(); dm.state.dm = false;
  await handlePunishmentConfig(dm.command, store);
  assert.deepEqual(dm.fetched, []);
  assert.equal(store.getSettings(id.guild).punishmentNoticesEnabled, true);
  assert.equal(store.getSettings(id.guild).punishmentDmEnabled, false);
  const disable = fixture(); disable.channels.clear(); disable.state.enabled = false;
  await handlePunishmentConfig(disable.command, store);
  assert.deepEqual(disable.fetched, []);
  assert.equal(store.getSettings(id.guild).punishmentChannelId, id.notice);
  assert.equal(store.getSettings(id.guild).punishmentNoticesEnabled, false);
  const enable = fixture(); enable.state.enabled = true;
  await handlePunishmentConfig(enable.command, store);
  assert.deepEqual(enable.fetched, [id.notice]);
  assert.equal(store.getSettings(id.guild).punishmentChannelId, id.notice);
  assert.equal(store.getSettings(id.guild).punishmentNoticesEnabled, true);
}));

test('enabling notices requires an existing validated destination', withStore(async (store) => {
  const f = fixture(); f.state.enabled = true;
  await assert.rejects(handlePunishmentConfig(f.command, store), /請先填寫通知/);
  assert.deepEqual(f.fetched, []); assert.deepEqual(store.listCases(id.guild), []);
  assert.equal(store.getSettings(id.guild).punishmentNoticesEnabled, false);
}));

test('native permission revocation during a target lookup prevents configuration and test sends', withStore(async (store) => {
  for (const testing of [false, true]) {
    const f = fixture();
    if (testing) {
      store.updateSettings(id.guild, { punishmentChannelId: id.notice, punishmentNoticesEnabled: true });
      f.state.subcommand = 'punishment-test';
    } else f.state.selected = id.notice;
    const original = store.getSettings(id.guild);
    f.state.onChannel = () => { f.actor.permissions.remove(P.ManageGuild); };
    await assert.rejects(handlePunishmentConfig(f.command, store), /原生.*管理伺服器/);
    assert.deepEqual(store.getSettings(id.guild), original);
    assert.deepEqual(store.listCases(id.guild), []); assert.deepEqual(f.sent, []);
  }
}));

test('concurrent setting changes cancel stale saves and stale test sends', withStore(async (store) => {
  for (const testing of [false, true]) {
    store.updateSettings(id.guild, { punishmentChannelId: id.notice,
      punishmentNoticesEnabled: true, punishmentDmEnabled: true });
    const f = fixture();
    if (testing) f.state.subcommand = 'punishment-test';
    else f.state.selected = id.alternate;
    f.state.onChannel = () => { store.updateSettings(id.guild, { punishmentDmEnabled: false }); };
    await assert.rejects(handlePunishmentConfig(f.command, store), /設定.*變更|修改了處罰通知設定/);
    assert.equal(store.getSettings(id.guild).punishmentDmEnabled, false);
    assert.equal(store.getSettings(id.guild).punishmentChannelId, id.notice);
    assert.deepEqual(store.listCases(id.guild), []); assert.deepEqual(f.sent, []);
  }
}));

test('test delivery goes only to the enabled configured target and creates no punishment or case', withStore(async (store) => {
  store.updateSettings(id.guild, { punishmentChannelId: id.notice, punishmentNoticesEnabled: true });
  const f = fixture(); f.state.subcommand = 'punishment-test';
  await handlePunishmentConfig(f.command, store);
  assert.deepEqual(f.fetched, [id.notice]); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]?.channelId, id.notice);
  const embed = f.sent[0]?.payload.embeds?.[0]?.toJSON();
  assert.match(embed?.title ?? '', /測試/);
  assert.match(embed?.description ?? '', /未對任何成員執行處罰/);
  assert.match(embed?.footer?.text ?? '', /不會建立處罰案件/);
  assert.deepEqual(f.sent[0]?.payload.allowedMentions, { parse: [] });
  assert.deepEqual(store.listCases(id.guild), []); assert.deepEqual(store.listWarnings(id.guild, id.actor), []);
  assert.match(f.output(), new RegExp(id.notice));
}));

test('disabled test delivery cannot send to either a saved target or invoking channel', withStore(async (store) => {
  store.updateSettings(id.guild, { punishmentChannelId: id.notice, punishmentNoticesEnabled: false });
  const f = fixture(); f.state.subcommand = 'punishment-test';
  await assert.rejects(handlePunishmentConfig(f.command, store), /尚未啟用/);
  assert.deepEqual(f.fetched, []); assert.deepEqual(f.sent, []); assert.deepEqual(store.listCases(id.guild), []);
}));
