import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, Collection, OverwriteType, PermissionFlagsBits as P, PermissionsBitField, type ChatInputCommandInteraction } from 'discord.js';
import { handleSubareaTools, parseSubareaMessage, lockAwareRestrictionBaseline, overlaySubareaLock, LOCK_PERMISSION_BITS, managedAreaOperation } from '../src/subarea-tools.js';
import { Store } from '../src/store.js';

const id = { guild: '400000000000000001', actor: '400000000000000002', bot: '400000000000000003',
  channel: '400000000000000004', target: '400000000000000005', admin: '400000000000000006',
  message: '400000000000000007', role: '400000000000000008', other: '400000000000000009' };
type Overwrite = { id: string; type: OverwriteType; allow: PermissionsBitField; deny: PermissionsBitField };
type Payload = { content?: string; embeds?: unknown[]; components?: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }> };
function fixture(store: Store, action: string, thread = false) {
  const state = { action, actorId: id.actor, message: id.message, name: '新名稱', seconds: 10,
    onFetch: () => {}, onConfirm: (_stage: number) => {}, confirmations: [true, true], confirmationCount: 0,
    privateMembers: new Set<string>([id.actor, id.target]), onPrivateFetch: (_userId: string) => {},
    failSet: false, failedSet: false, endpointDeleted: false };
  const replies: Payload[] = [];
  const counters = { pin: 0, unpin: 0, deleteMessage: 0, deleteChannel: 0, set: 0, edits: 0 };
  const base = P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.SendMessagesInThreads | P.AddReactions;
  const members = new Map<string, { id: string; permissions: PermissionsBitField; user: { id: string; bot: boolean }; guild: { ownerId: string } }>();
  function member(userId: string, permissions: bigint = base, bot = false) {
    const value = { id: userId, permissions: new PermissionsBitField(permissions), user: { id: userId, bot }, guild: { ownerId: id.admin } };
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
    async delete() { counters.deleteChannel++; state.endpointDeleted = true; },
  };
  const guild = { id: id.guild, ownerId: id.admin,
    roles: { async fetch() {} }, members: {
      async fetch(options: { user: string }) { const result = members.get(options.user); assert.ok(result); return result; },
      async fetchMe() { return bot; },
    }, channels: { async fetch(channelId: string) { assert.equal(channelId, id.channel); return channel; } } };
  const command = {
    id: '400000000000000010', guild, guildId: id.guild, channelId: id.channel,
    get user() { return { id: state.actorId }; },
    options: { getSubcommand: () => state.action, getString: (name: string) => name === 'message' ? state.message : state.name,
      getInteger: () => state.seconds, getUser: () => target.user },
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
  return { state, counters, channel, actor, bot, target, admin, command, replies, cache, overwrite };
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

test('thread locking uses native archive and lock without replacing channel overwrites', withStore(async (store) => {
  const f = fixture(store, 'lock', true); await handleSubareaTools(f.command, store);
  assert.equal(f.channel.locked, true); assert.equal(f.channel.archived, true); assert.equal(f.counters.set, 0);
  f.state.action = 'unlock'; await handleSubareaTools(f.command, store); assert.equal(f.channel.locked, false); assert.equal(f.channel.archived, false);
}));

test('deleting an area requires two confirmations and tolerates invalidated reply endpoint', withStore(async (store) => {
  const f = fixture(store, 'delete'); await handleSubareaTools(f.command, store);
  assert.equal(f.state.confirmationCount, 2); assert.equal(f.counters.deleteChannel, 1); assert.equal(store.getSubarea(id.guild, id.channel), null);
  assert.equal(store.listCases(id.guild)[0]?.action, 'subarea-delete');
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
