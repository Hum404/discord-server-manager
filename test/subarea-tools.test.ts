import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, Collection, OverwriteType, PermissionFlagsBits as P, PermissionsBitField, type ChatInputCommandInteraction, type Client, type EmbedBuilder } from 'discord.js';
import { handleSubareaTools, parseSubareaMessage, lockAwareRestrictionBaseline, overlaySubareaLock, LOCK_PERMISSION_BITS, managedAreaOperation, reconcileSubareaLocks, resolveSubareaLockTarget } from '../src/subarea-tools.js';
import { Store } from '../src/store.js';
import { handleSubareaCommand } from '../src/subareas.js';

const id = { guild: '400000000000000001', actor: '400000000000000002', bot: '400000000000000003',
  channel: '400000000000000004', target: '400000000000000005', admin: '400000000000000006',
  message: '400000000000000007', role: '400000000000000008', other: '400000000000000009',
  notice: '400000000000000011', log: '400000000000000012' };
type Overwrite = { id: string; type: OverwriteType; allow: PermissionsBitField; deny: PermissionsBitField };
type Payload = { content?: string; embeds?: EmbedBuilder[]; components?: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>;
  allowedMentions?: { parse: string[] } };
function fixture(store: Store, action: string, thread = false) {
  const state = { action, actorId: id.actor, message: id.message, name: '新名稱', seconds: 10,
    onFetch: () => {}, onConfirm: (_stage: number) => {}, confirmations: [true, true], confirmationCount: 0,
    privateMembers: new Set<string>([id.actor, id.target]), onPrivateFetch: (_userId: string) => {},
    invokingChannelId: id.channel, selectedChannelId: null as string | null, onChannelFetch: (_channelId: string) => {},
    channelIdInput: null as string | null,
    failSet: false, failedSet: false, endpointDeleted: false, failNotice: false };
  const replies: Payload[] = [];
  const sent: Array<{ channelId: string; payload: Payload }> = [];
  const directMessages: Array<{ userId: string; payload: unknown }> = [];
  const fetchedChannels: string[] = [];
  const counters = { pin: 0, unpin: 0, deleteMessage: 0, deleteChannel: 0, set: 0, edits: 0, outsideWrites: 0 };
  const base = P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.SendMessagesInThreads | P.AddReactions | P.UseApplicationCommands;
  const members = new Map<string, { id: string; permissions: PermissionsBitField; user: { id: string; bot: boolean }; guild: { ownerId: string }; send(payload: unknown): Promise<void> }>();
  function member(userId: string, permissions: bigint = base, bot = false) {
    const value = { id: userId, permissions: new PermissionsBitField(permissions), user: { id: userId, bot }, guild: { ownerId: id.admin },
      async send(payload: unknown) { directMessages.push({ userId, payload }); } };
    members.set(userId, value); return value;
  }
  const actor = member(id.actor); const bot = member(id.bot, PermissionsBitField.All, true);
  const target = member(id.target); const admin = member(id.admin, P.Administrator);
  const cache = new Collection<string, Overwrite>();
  function overwrite(userId: string, allow = 0n, deny = 0n, type = OverwriteType.Member) {
    cache.set(userId, { id: userId, type, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) });
  }
  const message = { id: id.message, channelId: id.channel, guildId: id.guild,
    async pin() { counters.pin++; }, async unpin() { counters.unpin++; }, async delete() { counters.deleteMessage++; } };
  const channel = {
    id: id.channel, guildId: id.guild, type: thread ? ChannelType.PublicThread : ChannelType.GuildText,
    ownerId: id.actor,
    guild: { id: id.guild, ownerId: id.admin },
    locked: false, archived: false, rateLimitPerUser: 0,
    members: { async fetch(options: { member: string; force: boolean; cache: boolean }) {
      assert.equal(options.force, true); assert.equal(options.cache, false);
      state.onPrivateFetch(options.member);
      if (!state.privateMembers.has(options.member)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
      return { id: options.member };
    } },
    permissionsFor(subject: { id: string; permissions: PermissionsBitField }) {
      if (subject.permissions.has(P.Administrator)) return new PermissionsBitField(PermissionsBitField.All);
      const permissions = new PermissionsBitField(subject.permissions.bitfield);
      for (const entry of [cache.get(id.guild), cache.get(subject.id)]) if (entry) {
        permissions.remove(entry.deny.bitfield); permissions.add(entry.allow.bitfield);
      }
      if (!permissions.has(P.ViewChannel)) permissions.remove([P.SendMessages, P.SendMessagesInThreads, P.UseApplicationCommands]);
      return permissions;
    },
    permissionOverwrites: { cache,
      async set(entries: Array<{ id: string; type: OverwriteType; allow: bigint; deny: bigint }>) {
        counters.set++;
        if (state.failSet && !state.failedSet) { state.failedSet = true; throw Object.assign(new Error('Denied'), { code: 50013 }); }
        cache.clear(); for (const entry of entries) overwrite(entry.id, entry.allow, entry.deny, entry.type);
      } },
    messages: { async fetch(options: { message: string; force: boolean; cache: boolean }) {
      assert.equal(options.message, id.message); assert.equal(options.force, true); assert.equal(options.cache, false);
      state.onFetch(); return message;
    } },
    async setRateLimitPerUser(seconds: number) { channel.rateLimitPerUser = seconds; counters.edits++; },
    async setName(name: string) { assert.equal(name, state.name); counters.edits++; },
    async edit(options: { locked: boolean; archived: boolean }) { channel.locked = options.locked; channel.archived = options.archived; counters.edits++; },
    async delete() { counters.deleteChannel++; state.endpointDeleted = true; channels.delete(id.channel); },
    async send(payload: Payload) {
      if (state.failNotice) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      const notice = { channelId: id.channel, payload };
      sent.push(notice);
      return { id: '400000000000000013', channelId: id.channel, guildId: id.guild,
        async edit(value: Payload) { notice.payload = value; },
        async delete() { const index = sent.indexOf(notice); if (index >= 0) sent.splice(index, 1); } };
    },
  };
  const outsideCache = new Collection<string, Overwrite>();
  const outside = {
    id: id.other, guildId: id.guild, type: ChannelType.GuildText,
    guild: { id: id.guild, ownerId: id.admin },
    permissionsFor(subject: { permissions: PermissionsBitField }) { return new PermissionsBitField(subject.permissions.bitfield); },
    permissionOverwrites: { cache: outsideCache, async set() { counters.outsideWrites++; } },
    async send(payload: Payload) { sent.push({ channelId: id.other, payload }); },
  };
  function notificationChannel(channelId: string) {
    return { ...outside, id: channelId,
      async send(payload: Payload) {
        if (channelId === id.notice && state.failNotice) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
        sent.push({ channelId, payload });
      } };
  }
  const notice = notificationChannel(id.notice); const log = notificationChannel(id.log);
  const channels = new Map<string, typeof channel | typeof outside>([
    [channel.id, channel], [outside.id, outside], [notice.id, notice], [log.id, log],
  ]);
  const guild = { id: id.guild, ownerId: id.admin,
    roles: { async fetch() {} }, members: {
      async fetch(options: { user: string }) { const result = members.get(options.user); assert.ok(result); return result; },
      async fetchMe() { return bot; },
    }, channels: { async fetch(channelId: string) { fetchedChannels.push(channelId); state.onChannelFetch(channelId); return channels.get(channelId) ?? null; } } };
  const command = {
    id: '400000000000000010', guild, guildId: id.guild, get channelId() { return state.invokingChannelId; },
    get user() { return { id: state.actorId }; },
    options: { getSubcommand: () => state.action, getString: (name: string) => name === 'channel-id' ? state.channelIdInput : name === 'message' ? state.message : state.name,
      getInteger: () => state.seconds, getUser: () => target.user,
      getChannel: () => state.selectedChannelId === null ? null : channels.get(state.selectedChannelId) ?? null },
    async editReply(payload: Payload) {
      if (state.endpointDeleted) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
      replies.push(payload);
      return { async awaitMessageComponent(options: { filter(value: { user: { id: string }; customId: string }): boolean }) {
        const customId = payload.components?.[0]?.toJSON().components[0]?.custom_id;
        assert.ok(customId);
        assert.equal(options.filter({ user: { id: id.other }, customId }), false);
        assert.equal(options.filter({ user: { id: state.actorId }, customId: 'forged' }), false);
        assert.equal(options.filter({ user: { id: state.actorId }, customId }), true);
        const stage = state.confirmationCount++;
        return { customId: state.confirmations[stage] ? customId : customId.replace(/:yes$/, ':no'),
          async update(value: Payload) { replies.push(value); state.onConfirm(stage + 1); } };
      } };
    },
  } as unknown as ChatInputCommandInteraction<'cached'>;
  store.setSubarea(id.guild, id.channel, id.actor);
  return { state, counters, channel, outside, channels, guild, actor, bot, target, admin, command, replies, sent, directMessages, fetchedChannels, cache, overwrite };
}
function withStore(run: (store: Store) => Promise<void> | void) {
  return async () => { const store = new Store(':memory:'); try { await run(store); } finally { store.close(); } };
}

test('subarea message identifiers reject cross-guild/channel links and non-Discord hosts', () => {
  assert.equal(parseSubareaMessage(id.message, id.guild, id.channel), id.message);
  assert.equal(parseSubareaMessage(`https://discord.com/channels/${id.guild}/${id.channel}/${id.message}`, id.guild, id.channel), id.message);
  for (const value of [`https://discord.com/channels/${id.guild}/${id.other}/${id.message}`,
    `https://discord.com/channels/${id.other}/${id.channel}/${id.message}`,
    `https://example.com/channels/${id.guild}/${id.channel}/${id.message}`, '123', 'https://discord.com@evil.test/channels/123']) {
    assert.throws(() => parseSubareaMessage(value, id.guild, id.channel));
  }
});

test('creator can pin a message without receiving native moderation permissions', withStore(async (store) => {
  const f = fixture(store, 'pin'); await handleSubareaTools(f.command, store);
  assert.equal(f.counters.pin, 1); assert.equal(f.actor.permissions.has(P.PinMessages), false);
  assert.equal(store.listCases(id.guild)[0]?.action, 'subarea-pin');
}));

test('pinning is creator only, including administrators and local delegates', withStore(async (store) => {
  const f = fixture(store, 'pin'); store.setSubareaDelegate(id.guild, id.channel, id.target, id.actor);
  for (const actorId of [id.target, id.admin]) {
    f.state.actorId = actorId; await assert.rejects(handleSubareaTools(f.command, store), /只有目前子區建立者/);
  }
  assert.equal(f.counters.pin, 0);
}));

test('ownership is rechecked after message lookup before pinning', withStore(async (store) => {
  const f = fixture(store, 'pin'); f.state.onFetch = () => { store.setSubarea(id.guild, id.channel, id.other); };
  await assert.rejects(handleSubareaTools(f.command, store), /只有目前子區建立者/); assert.equal(f.counters.pin, 0);
}));

test('a missing native Bot PinMessages permission blocks pinning', withStore(async (store) => {
  const f = fixture(store, 'pin'); f.bot.permissions.remove([P.Administrator, P.PinMessages]);
  await assert.rejects(handleSubareaTools(f.command, store), /機器人缺少/); assert.equal(f.counters.pin, 0);
}));

test('delegates may edit slowmode but cannot grant additional delegates', withStore(async (store) => {
  const f = fixture(store, 'slowmode'); store.setSubareaDelegate(id.guild, id.channel, id.target, id.actor);
  f.state.actorId = id.target; await handleSubareaTools(f.command, store); assert.equal(f.channel.rateLimitPerUser, 10);
  f.state.action = 'delegate'; await assert.rejects(handleSubareaTools(f.command, store), /只有子區建立者或伺服器管理員/);
}));

function configureSeparateServerDestinations(store: Store) {
  store.updateSettings(id.guild, { punishmentNoticesEnabled: false, punishmentIncludeSubareas: false,
    punishmentChannelId: id.notice, logChannelId: id.log });
}

for (const thread of [false, true]) {
  const kind = thread ? 'thread' : 'text area';
  test(`a ${kind} creator delegate grant and revocation announce locally by default without enabling server announcements`, withStore(async (store) => {
    const f = fixture(store, 'delegate', thread); configureSeparateServerDestinations(store);
    await handleSubareaTools(f.command, store);
    assert.equal(store.getSubareaDelegate(id.guild, id.channel, id.target)?.grantedBy, id.actor);
    f.state.action = 'undelegate';
    await handleSubareaTools(f.command, store);
    assert.equal(store.getSubareaDelegate(id.guild, id.channel, id.target), null);
    assert.deepEqual(f.sent.map((entry) => entry.channelId), [id.channel, id.channel]);
    assert.equal(f.fetchedChannels.includes(id.notice), false);
    assert.equal(f.fetchedChannels.includes(id.log), false);
    assert.equal(f.actor.permissions.has(P.ManageGuild), false);
    for (const entry of f.sent) {
      const embed = entry.payload.embeds?.[0]?.toJSON();
      assert.match(embed?.title ?? '', /^子區管理通知/);
      assert.match(embed?.title ?? '', /協管/);
      const output = JSON.stringify(embed);
      for (const userId of [id.actor, id.target]) assert.match(output, new RegExp(`<@${userId}>`));
      assert.match(output, new RegExp(`<#${id.channel}>`));
      assert.deepEqual(entry.payload.components, [], 'appointing or dismissing a delegate is not an appealable sanction');
      assert.deepEqual(entry.payload.allowedMentions, { parse: [] });
    }
    assert.deepEqual(store.listServerCases(id.guild), []);
    const records = store.listMemberCases(id.guild, id.actor);
    assert.deepEqual(records.map((entry) => entry.action), ['subarea-undelegate', 'subarea-delegate']);
    assert.ok(records.every((entry) => entry.userId === id.target && entry.channelId === id.channel));
  }));

  test(`an unauthorized or failed ${kind} delegate change cannot produce a success announcement`, withStore(async (store) => {
    const f = fixture(store, 'delegate', thread); configureSeparateServerDestinations(store);
    store.setSubareaDelegate(id.guild, id.channel, id.target, id.actor);
    f.state.actorId = id.target;
    await assert.rejects(handleSubareaTools(f.command, store), /只有子區建立者或伺服器管理員/);
    f.state.actorId = id.actor;
    store.setSubareaDelegate = () => { throw new Error('SQLite write failed'); };
    await assert.rejects(handleSubareaTools(f.command, store), /SQLite write failed/);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(store.listCases(id.guild), []);
  }));

  test(`${kind} pinning and confirmed message deletion notify without fabricating a target member`, withStore(async (store) => {
    const f = fixture(store, 'pin', thread); configureSeparateServerDestinations(store);
    await handleSubareaTools(f.command, store);
    f.state.action = 'delete-message';
    await handleSubareaTools(f.command, store);
    assert.equal(f.counters.pin, 1); assert.equal(f.counters.deleteMessage, 1);
    assert.deepEqual(f.sent.map((entry) => entry.channelId), [id.channel, id.channel]);
    assert.equal(f.fetchedChannels.includes(id.notice), false);
    assert.equal(f.fetchedChannels.includes(id.log), false);
    for (const entry of f.sent) {
      const output = JSON.stringify(entry.payload.embeds?.[0]?.toJSON());
      assert.match(output, /子區管理通知/);
      assert.match(output, new RegExp(`<#${id.channel}>`));
      assert.doesNotMatch(output, /<@null>|<@undefined>/);
      assert.deepEqual(entry.payload.components, []);
    }
    assert.ok(store.listMemberCases(id.guild, id.actor).every((entry) => entry.userId === null));
    assert.deepEqual(store.listServerCases(id.guild), []);
  }));
}

test('management notification failure preserves the successful delegate grant and member record', withStore(async (store) => {
  const f = fixture(store, 'delegate'); configureSeparateServerDestinations(store); f.state.failNotice = true;
  await handleSubareaTools(f.command, store);
  assert.equal(store.getSubareaDelegate(id.guild, id.channel, id.target)?.grantedBy, id.actor);
  assert.equal(store.listMemberCases(id.guild, id.actor)[0]?.action, 'subarea-delegate');
  assert.deepEqual(store.listServerCases(id.guild), []);
  assert.deepEqual(f.sent, [], 'failed local delivery must not fall back to any configured destination or server log');
  assert.equal(f.fetchedChannels.includes(id.notice), false);
  assert.equal(f.fetchedChannels.includes(id.log), false);
  assert.match(f.replies.at(-1)?.content ?? '', /通知發送失敗/);
}));

test('child-area managers respect the independent local notice switch while server announcements remain enabled', withStore(async (store) => {
  const f = fixture(store, 'delegate'); configureSeparateServerDestinations(store);
  store.updateSettings(id.guild, { punishmentNoticesEnabled: true, punishmentIncludeSubareas: true, subareaNoticesEnabled: false });
  await handleSubareaTools(f.command, store);
  assert.equal(store.getSubareaDelegate(id.guild, id.channel, id.target)?.grantedBy, id.actor);
  assert.equal(f.sent.length, 0);
  assert.equal(f.fetchedChannels.includes(id.notice), false);
  assert.equal(f.fetchedChannels.includes(id.log), false);
  store.updateSettings(id.guild, { subareaNoticesEnabled: true, punishmentNoticesEnabled: false });
  f.state.action = 'undelegate';
  await handleSubareaTools(f.command, store);
  assert.deepEqual(f.sent.map((entry) => entry.channelId), [id.channel]);
  assert.equal(store.listMemberCases(id.guild, id.actor).length, 2);
  assert.deepEqual(store.listServerCases(id.guild), []);
}));

test('outside-channel locking announces the selected child area instead of the invoking channel', withStore(async (store) => {
  const f = fixture(store, 'lock'); configureSeparateServerDestinations(store);
  f.state.invokingChannelId = id.other; f.state.selectedChannelId = id.channel;
  await handleSubareaTools(f.command, store);
  assert.ok(store.getSubareaLock(id.guild, id.channel));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0]?.channelId, id.channel);
  assert.equal(f.fetchedChannels.includes(id.notice), false);
  assert.equal(f.fetchedChannels.includes(id.log), false);
  const output = JSON.stringify(f.sent[0]?.payload.embeds?.[0]?.toJSON());
  assert.match(output, /子區管理通知/);
  assert.match(output, new RegExp(`<#${id.channel}>`));
  assert.doesNotMatch(output, new RegExp(`<#${id.other}>`));
  assert.equal(store.listMemberCases(id.guild, id.actor)[0]?.channelId, id.channel);
  assert.deepEqual(store.listServerCases(id.guild), []);
}));

test('message deletion confirmation rechecks revoked delegate permission', withStore(async (store) => {
  const f = fixture(store, 'delete-message'); store.setSubareaDelegate(id.guild, id.channel, id.target, id.actor);
  f.state.actorId = id.target; f.state.onConfirm = () => { store.deleteSubareaDelegate(id.guild, id.channel, id.target); };
  await assert.rejects(handleSubareaTools(f.command, store), /只有子區建立者、協管/); assert.equal(f.counters.deleteMessage, 0);
}));

test('delegates do not leak to another area', withStore(async (store) => {
  const f = fixture(store, 'rename'); store.setSubarea(id.guild, id.other, id.actor);
  store.setSubareaDelegate(id.guild, id.other, id.target, id.actor); f.state.actorId = id.target;
  await assert.rejects(handleSubareaTools(f.command, store), /只有子區建立者、協管/); assert.equal(f.counters.edits, 0);
}));

test('locking text channels denies explicit member and role send grants, preserving creator and Bot', withStore(async (store) => {
  const f = fixture(store, 'lock'); f.overwrite(id.role, P.SendMessages, 0n, OverwriteType.Role); f.overwrite(id.target, P.SendMessages);
  await handleSubareaTools(f.command, store);
  for (const userId of [id.guild, id.role, id.target]) assert.equal(f.cache.get(userId)?.deny.has(P.SendMessages), true);
  for (const userId of [id.actor, id.bot]) assert.equal(f.cache.get(userId)?.allow.has(P.SendMessages), true);
  assert.ok(store.getSubareaLock(id.guild, id.channel));
}));

test('unlock retains an active mute and preserves unrelated edits made during the lock', withStore(async (store) => {
  const f = fixture(store, 'lock'); f.overwrite(id.target, P.SendMessages | P.AttachFiles);
  store.setSubareaRestriction({ guildId: id.guild, channelId: id.channel, userId: id.target, muted: true, kicked: false,
    originalAllow: String(P.SendMessages | P.AttachFiles), originalDeny: '0', moderatorId: id.actor, reason: '原限制' });
  f.overwrite(id.target, P.AttachFiles, LOCK_PERMISSION_BITS);
  await handleSubareaTools(f.command, store);
  const current = f.cache.get(id.target)!; f.overwrite(id.target, current.allow.bitfield | P.EmbedLinks, current.deny.bitfield);
  f.state.action = 'unlock'; await handleSubareaTools(f.command, store);
  assert.equal(f.cache.get(id.target)?.deny.has(P.SendMessages), true); assert.equal(f.cache.get(id.target)?.allow.has(P.EmbedLinks), true);
  assert.equal(store.getSubareaLock(id.guild, id.channel), null);
}));

test('clearing a pre-existing mute during lock restores original allow after unlocking', withStore(async (store) => {
  const f = fixture(store, 'lock'); f.overwrite(id.target, P.AttachFiles, LOCK_PERMISSION_BITS);
  store.setSubareaRestriction({ guildId: id.guild, channelId: id.channel, userId: id.target, muted: true, kicked: false,
    originalAllow: String(P.SendMessages | P.AttachFiles), originalDeny: '0', moderatorId: id.actor, reason: '原限制' });
  await handleSubareaTools(f.command, store);
  const previous = store.getSubareaRestriction(id.guild, id.channel, id.target)!;
  store.setSubareaRestriction({ ...previous, muted: false });
  f.state.action = 'unlock'; await handleSubareaTools(f.command, store);
  assert.equal(f.cache.get(id.target)?.allow.has(P.SendMessages), true); assert.equal(f.cache.get(id.target)?.deny.has(P.SendMessages), false);
  assert.equal(store.getSubareaRestriction(id.guild, id.channel, id.target), null);
}));

test('lock-aware baseline and overlay prevent unmuting from opening locked text channels', withStore(async (store) => {
  const f = fixture(store, 'lock'); f.overwrite(id.target, P.SendMessages | P.AttachFiles);
  await handleSubareaTools(f.command, store);
  const current = f.cache.get(id.target)!;
  const baseline = lockAwareRestrictionBaseline(store, id.guild, id.channel, id.target, { allow: current.allow.bitfield, deny: current.deny.bitfield });
  assert.equal(BigInt(baseline.originalAllow!) & P.SendMessages, P.SendMessages);
  const overlay = overlaySubareaLock(store, id.guild, id.channel, id.target, BigInt(baseline.originalAllow!), BigInt(baseline.originalDeny!));
  assert.equal(overlay.allow & P.SendMessages, 0n); assert.equal(overlay.deny & P.SendMessages, P.SendMessages);
}));

test('members introduced during a lock restore their saved baseline on unlock', withStore(async (store) => {
  const f = fixture(store, 'lock'); await handleSubareaTools(f.command, store);
  store.setSubareaRestriction({ guildId: id.guild, channelId: id.channel, userId: id.target, muted: false, kicked: false,
    originalAllow: String(P.SendMessages | P.AttachFiles), originalDeny: '0', moderatorId: id.actor, reason: '已解除限制' });
  f.overwrite(id.target, P.AttachFiles, LOCK_PERMISSION_BITS);
  f.state.action = 'unlock'; await handleSubareaTools(f.command, store);
  assert.equal(f.cache.get(id.target)?.allow.has(P.SendMessages), true);
  assert.equal(store.getSubareaRestriction(id.guild, id.channel, id.target), null);
}));

test('failed text lock rolls back durable record and original overwrites', withStore(async (store) => {
  const f = fixture(store, 'lock'); f.overwrite(id.target, P.SendMessages); f.state.failSet = true;
  await assert.rejects(handleSubareaTools(f.command, store), /Denied/);
  assert.equal(store.getSubareaLock(id.guild, id.channel), null); assert.equal(f.cache.get(id.target)?.allow.has(P.SendMessages), true);
  assert.equal(f.cache.has(id.guild), false);
}));

test('thread locking uses native archive and lock without replacing parent overwrites', withStore(async (store) => {
  const f = fixture(store, 'lock', true); await handleSubareaTools(f.command, store);
  assert.equal(f.channel.locked, true); assert.equal(f.channel.archived, true); assert.equal(f.counters.set, 0);
  assert.equal(store.getSubareaLock(id.guild, id.channel)?.mode, 'thread-native');
  f.state.action = 'unlock'; await handleSubareaTools(f.command, store); assert.equal(f.channel.locked, false); assert.equal(f.channel.archived, false);
  assert.equal(store.getSubareaLock(id.guild, id.channel), null);
}));

test('a text administrator lock preserves creator controls but can only be released by a native administrator', withStore(async (store) => {
  const f = fixture(store, 'lock'); f.state.actorId = id.admin;
  await handleSubareaTools(f.command, store);
  const lock = store.getSubareaLock(id.guild, id.channel)!;
  assert.equal(lock.mode, 'text'); assert.equal(lock.source, 'admin');
  assert.equal(f.channel.permissionsFor(f.actor).has([P.SendMessages, P.UseApplicationCommands]), true);
  store.setSubareaDelegate(id.guild, id.channel, id.target, id.actor);
  for (const userId of [id.actor, id.target]) {
    f.state.actorId = userId; f.state.action = 'unlock';
    await assert.rejects(handleSubareaTools(f.command, store), /管理員|處分/);
    f.state.action = 'lock';
    await assert.rejects(handleSubareaTools(f.command, store), /管理員|處分/);
    assert.equal(store.getSubareaLock(id.guild, id.channel)?.lockId, lock.lockId);
  }
  f.state.actorId = id.admin; f.state.action = 'unlock';
  await handleSubareaTools(f.command, store);
  assert.equal(store.getSubareaLock(id.guild, id.channel), null);
}));

test('admin promotion of a text lock retains its pre-lock permission baseline and invalidates previous unlock buttons', withStore(async (store) => {
  const f = fixture(store, 'lock'); f.overwrite(id.target, P.SendMessages | P.AttachFiles);
  await handleSubareaTools(f.command, store);
  const ownerLock = store.getSubareaLock(id.guild, id.channel)!;
  f.state.actorId = id.admin;
  await handleSubareaTools(f.command, store);
  const promoted = store.getSubareaLock(id.guild, id.channel)!;
  assert.equal(promoted.source, 'admin'); assert.equal(promoted.lockedBy, id.admin);
  assert.equal(promoted.overwrites, ownerLock.overwrites); assert.equal(promoted.createdAt, ownerLock.createdAt);
  assert.notEqual(promoted.lockId, ownerLock.lockId);
  f.state.action = 'unlock'; await handleSubareaTools(f.command, store);
  assert.equal(f.cache.get(id.target)?.allow.has([P.SendMessages, P.AttachFiles]), true);
  assert.equal(f.cache.get(id.target)?.deny.has(P.SendMessages), false);
}));

test('a legacy text lock is kept until a native administrator confirms its release', withStore(async (store) => {
  const f = fixture(store, 'unlock'); store.setSubareaLock(id.guild, id.channel, '[]', id.actor);
  await assert.rejects(handleSubareaTools(f.command, store), /管理員|來源|舊版/);
  assert.equal(f.counters.set, 0);
  f.state.actorId = id.admin; await handleSubareaTools(f.command, store);
  assert.equal(store.getSubareaLock(id.guild, id.channel), null);
}));

for (const thread of [false, true]) {
  for (const source of ['admin', 'legacy'] as const) {
    test(`a ${source}-protected ${thread ? 'thread' : 'text area'} blocks creator mutations while allowing information and delegate inspection`, withStore(async (store) => {
      const f = fixture(store, 'delete', thread);
      const lock = store.setSubareaLock(id.guild, id.channel, '[]', id.admin,
        { mode: thread ? 'thread-native' : 'text', source });
      if (thread) { f.channel.locked = true; f.channel.archived = true; }
      for (const action of ['delete', 'rename', 'slowmode', 'delegate', 'undelegate', 'pin', 'unpin', 'delete-message']) {
        f.state.action = action;
        await assert.rejects(handleSubareaTools(f.command, store), /管理員鎖定|管理員解除|管理員.*解除/);
      }
      for (const action of ['info', 'delegates']) {
        f.state.action = action;
        await handleSubareaTools(f.command, store);
      }
      assert.equal(f.state.confirmationCount, 0);
      assert.deepEqual(f.counters, { pin: 0, unpin: 0, deleteMessage: 0, deleteChannel: 0, set: 0, edits: 0, outsideWrites: 0 });
      assert.equal(store.getSubareaLock(id.guild, id.channel)?.lockId, lock.lockId);
      assert.deepEqual(store.listCases(id.guild), []);
      assert.deepEqual(f.sent, []);
    }));
  }
}

test('deleting an area requires two confirmations and tolerates invalidated reply endpoint', withStore(async (store) => {
  const f = fixture(store, 'delete'); configureSeparateServerDestinations(store); await handleSubareaTools(f.command, store);
  assert.equal(f.state.confirmationCount, 2); assert.equal(f.counters.deleteChannel, 1); assert.equal(store.getSubarea(id.guild, id.channel), null);
  assert.equal(store.listCases(id.guild)[0]?.action, 'subarea-delete');
  assert.equal(store.listMemberCases(id.guild, id.actor)[0]?.channelId, id.channel);
  assert.deepEqual(f.sent, [], 'a deleted area has no local destination and must not announce elsewhere');
  assert.equal(f.fetchedChannels.includes(id.notice), false);
  assert.equal(f.fetchedChannels.includes(id.log), false);
}));

test('owner change at final delete confirmation prevents deletion', withStore(async (store) => {
  const f = fixture(store, 'delete'); f.state.onConfirm = (stage) => { if (stage === 2) store.setSubarea(id.guild, id.channel, id.other); };
  await assert.rejects(handleSubareaTools(f.command, store), /只有目前子區建立者/); assert.equal(f.counters.deleteChannel, 0);
}));

test('per-area serialization releases after failure without blocking later operations', async () => {
  const order: number[] = [];
  const first = managedAreaOperation('test:serial', async () => { order.push(1); await Promise.resolve(); throw new Error('expected'); });
  const second = managedAreaOperation('test:serial', async () => { order.push(2); });
  await assert.rejects(first, /expected/); await second; assert.deepEqual(order, [1, 2]);
});

test('a private-thread creator must still have current private membership', withStore(async (store) => {
  const f = fixture(store, 'pin', true);
  f.channel.type = ChannelType.PrivateThread;
  f.state.privateMembers.delete(id.actor);
  await assert.rejects(handleSubareaTools(f.command, store), /私密討論串/);
  assert.equal(f.counters.pin, 0);
}));

test('removal from a private thread during delete-message confirmation prevents the deletion', withStore(async (store) => {
  const f = fixture(store, 'delete-message', true);
  f.channel.type = ChannelType.PrivateThread;
  f.state.onConfirm = () => { f.state.privateMembers.delete(id.actor); };
  await assert.rejects(handleSubareaTools(f.command, store), /私密討論串/);
  assert.equal(f.counters.deleteMessage, 0);
  assert.deepEqual(store.listCases(id.guild), []);
}));

test('revocation during private membership lookup prevents a queued delegate action', withStore(async (store) => {
  const f = fixture(store, 'slowmode', true);
  f.channel.type = ChannelType.PrivateThread;
  store.setSubareaDelegate(id.guild, id.channel, id.target, id.actor);
  f.state.actorId = id.target;
  f.state.onPrivateFetch = () => { store.deleteSubareaDelegate(id.guild, id.channel, id.target); };
  await assert.rejects(handleSubareaTools(f.command, store), /權限已變更/);
  assert.equal(f.counters.edits, 0);
}));

test('a user without private thread membership cannot be appointed its delegate', withStore(async (store) => {
  const f = fixture(store, 'delegate', true);
  f.channel.type = ChannelType.PrivateThread;
  f.state.privateMembers.delete(id.target);
  await assert.rejects(handleSubareaTools(f.command, store), /先加入/);
  assert.equal(store.getSubareaDelegate(id.guild, id.channel, id.target), null);
}));

test('native administrators can manage private-thread messages without joining', withStore(async (store) => {
  const f = fixture(store, 'delete-message', true);
  f.channel.type = ChannelType.PrivateThread;
  f.state.actorId = id.admin;
  await handleSubareaTools(f.command, store);
  assert.equal(f.counters.deleteMessage, 1);
}));

test('text lock preserves creator posting and application commands despite an everyone deny', withStore(async (store) => {
  const f = fixture(store, 'lock');
  f.state.invokingChannelId = id.other;
  f.state.selectedChannelId = id.channel;
  const denied = P.SendMessages | P.SendMessagesInThreads | P.UseApplicationCommands;
  f.overwrite(id.guild, 0n, denied, OverwriteType.Role);
  assert.equal(f.channel.permissionsFor(f.actor).has(P.SendMessages), false);
  await handleSubareaTools(f.command, store);
  const ownerPermissions = f.channel.permissionsFor(f.actor);
  assert.equal(ownerPermissions.has([P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.SendMessagesInThreads, P.UseApplicationCommands]), true);
  assert.equal(ownerPermissions.has(P.Administrator), false);
  assert.equal(ownerPermissions.has(P.ManageRoles), false);
  assert.equal(ownerPermissions.has(P.ManageThreads), false);
  assert.equal(f.channel.permissionsFor(f.target).has(P.SendMessages), false);
  assert.equal(f.counters.outsideWrites, 0);
  f.state.action = 'unlock';
  await handleSubareaTools(f.command, store);
  assert.equal(f.cache.has(id.actor), false, 'temporary creator control overwrite is removed');
  assert.equal(f.channel.permissionsFor(f.actor).has(P.UseApplicationCommands), false, 'the original command deny is restored');
  assert.equal(f.cache.get(id.guild)?.deny.bitfield, denied);
}));

test('startup reconciliation repairs creator control access for a saved older text lock', withStore(async (store) => {
  const f = fixture(store, 'lock');
  store.setSubareaLock(id.guild, id.channel, '[]', id.actor);
  f.overwrite(id.guild, 0n, P.SendMessages | P.UseApplicationCommands, OverwriteType.Role);
  f.overwrite(id.actor, 0n, P.SendMessages);
  assert.equal(f.channel.permissionsFor(f.actor).has(P.SendMessages), false);
  const client = { user: { id: id.bot }, guilds: { async fetch() { return f.guild; } } } as unknown as Client;
  await reconcileSubareaLocks(client, store);
  assert.equal(f.channel.permissionsFor(f.actor).has([P.SendMessages, P.UseApplicationCommands]), true);
  assert.equal(f.channel.permissionsFor(f.target).has(P.SendMessages), false);
  assert.ok(store.getSubareaLock(id.guild, id.channel));
}));

test('outside-channel unlock restores only the selected registered text area', withStore(async (store) => {
  const f = fixture(store, 'lock');
  await handleSubareaTools(f.command, store);
  f.state.action = 'unlock'; f.state.invokingChannelId = id.other; f.state.selectedChannelId = id.channel;
  await handleSubareaCommand(f.command, store);
  assert.equal(store.getSubareaLock(id.guild, id.channel), null);
  assert.equal(f.counters.outsideWrites, 0);
  assert.match(f.replies.at(-1)?.content ?? '', new RegExp(id.channel));
  assert.equal(store.listCases(id.guild)[0]?.action, 'subarea-unlock');
}));

test('outside recovery adopts a legacy human thread but requires an administrator to undo its untracked native lock', withStore(async (store) => {
  const f = fixture(store, 'unlock', true);
  store.deleteSubarea(id.guild, id.channel);
  f.channel.locked = true; f.channel.archived = true;
  f.state.invokingChannelId = id.other;
  f.state.channelIdInput = `https://discord.com/channels/${id.guild}/${id.channel}/${id.message}`;
  await assert.rejects(handleSubareaCommand(f.command, store), /管理員|來源|紀錄/);
  assert.equal(store.getSubarea(id.guild, id.channel)?.ownerId, id.actor);
  assert.equal(f.channel.locked, true); assert.equal(f.counters.edits, 0);
  f.state.actorId = id.admin;
  await handleSubareaCommand(f.command, store);
  assert.equal(f.channel.locked, false); assert.equal(f.channel.archived, false);
  assert.equal(f.counters.edits, 1); assert.equal(f.counters.outsideWrites, 0);
}));

test('outside unlock still rejects another creator and a revoked local delegate', withStore(async (store) => {
  const f = fixture(store, 'unlock');
  f.state.invokingChannelId = id.other; f.state.selectedChannelId = id.channel;
  store.setSubarea(id.guild, id.channel, id.target);
  store.setSubareaLock(id.guild, id.channel, '[]', id.target);
  await assert.rejects(handleSubareaTools(f.command, store), /只有子區建立者/);
  store.setSubareaDelegate(id.guild, id.channel, id.actor, id.target);
  f.state.onChannelFetch = () => { store.deleteSubareaDelegate(id.guild, id.channel, id.actor); };
  await assert.rejects(handleSubareaTools(f.command, store), /只有子區建立者/);
  assert.ok(store.getSubareaLock(id.guild, id.channel));
  assert.equal(f.counters.set, 0);
}));

test('outside unlock validates the selected guild and private thread membership', withStore(async (store) => {
  const f = fixture(store, 'unlock', true);
  f.state.invokingChannelId = id.other; f.state.selectedChannelId = id.channel;
  f.channel.guildId = id.other;
  await assert.rejects(handleSubareaTools(f.command, store), /已登記的文字子區或討論串/);
  f.channel.guildId = id.guild; f.channel.type = ChannelType.PrivateThread;
  f.state.privateMembers.delete(id.actor);
  f.channel.locked = true; f.channel.archived = true;
  await assert.rejects(handleSubareaTools(f.command, store), /私密討論串/);
  assert.equal(f.channel.locked, true); assert.equal(f.counters.edits, 0);
}));

test('lock target parsing accepts only one current-guild channel ID or Discord link', withStore((store) => {
  const f = fixture(store, 'unlock');
  assert.equal(resolveSubareaLockTarget(f.command), id.channel);
  f.state.channelIdInput = id.target;
  assert.equal(resolveSubareaLockTarget(f.command), id.target);
  for (const tail of [id.target, `${id.target}/${id.message}`]) {
    f.state.channelIdInput = `https://discord.com/channels/${id.guild}/${tail}`;
    assert.equal(resolveSubareaLockTarget(f.command), id.target);
  }
  for (const invalid of ['bad-id', `https://example.com/channels/${id.guild}/${id.target}`,
    `https://discord.com/channels/${id.other}/${id.target}`, `https://discord.com@evil.test/channels/${id.guild}/${id.target}`]) {
    f.state.channelIdInput = invalid;
    assert.throws(() => resolveSubareaLockTarget(f.command));
  }
  f.state.channelIdInput = id.target; f.state.selectedChannelId = id.channel;
  assert.throws(() => resolveSubareaLockTarget(f.command), /擇一/);
}));
