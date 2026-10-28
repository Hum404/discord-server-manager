import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChannelType, Collection, OverwriteType, PermissionFlagsBits, PermissionsBitField,
  type ChatInputCommandInteraction, type Client,
} from 'discord.js';
import {
  computeRestrictionPermissions, handleSubareaCommand, reconcileSubareaRestrictions,
  KICK_PERMISSION_BITS, MANAGED_PERMISSION_BITS, MUTE_PERMISSION_BITS,
} from '../src/subareas.js';
import { Store } from '../src/store.js';

const ids = {
  guild: '200000000000000001', actor: '200000000000000002', bot: '200000000000000003',
  target: '200000000000000004', channel: '200000000000000005', category: '200000000000000006',
  interaction: '200000000000000007', created: '200000000000000008', other: '200000000000000009',
  role: '200000000000000010',
};
const memberPermissions = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions, PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads,
]);
type Overwrite = { id: string; type: OverwriteType; allow: PermissionsBitField; deny: PermissionsBitField };
type FakeMember = {
  id: string; permissions: PermissionsBitField; roles: { highest: { position: number } };
  user: { id: string; username: string; bot: boolean }; guild: unknown;
  send(payload: unknown): Promise<void>; kick(): Promise<void>; timeout(): Promise<void>;
};
type Edit = { content?: string; allowedMentions?: unknown };

function fixture(store: Store, action: string, registered = true) {
  const counters = { kicks: 0, timeouts: 0, edits: 0, deletes: 0, creates: 0, notifications: 0 };
  const state = {
    action, confirmation: 'confirm' as 'confirm' | 'cancel' | 'timeout', failEdit: false,
    onConfirmation: () => {}, onNotification: () => {},
    message: '請查看本子區公告 @everyone',
  };
  const replies: Edit[] = [];
  const sent: Array<{ content: string; allowedMentions: unknown }> = [];
  const created: Array<{ permissionOverwrites: Array<{ id: string; type: number; allow: bigint; deny: bigint }>; parent: string }> = [];
  const members = new Map<string, FakeMember>();
  const actor = member(ids.actor, false, 5);
  const bot = member(ids.bot, true, 20);
  const target = member(ids.target, false, 1);
  bot.permissions.add([
    PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.MentionEveryone,
    PermissionFlagsBits.EmbedLinks,
  ]);
  function member(id: string, isBot: boolean, position: number): FakeMember {
    const value: FakeMember = {
      id, permissions: new PermissionsBitField(memberPermissions.bitfield), roles: { highest: { position } },
      user: { id, username: '測試用戶', bot: isBot }, guild: undefined,
      async send() { counters.notifications += 1; state.onNotification(); },
      async kick() { counters.kicks += 1; }, async timeout() { counters.timeouts += 1; },
    };
    members.set(id, value);
    return value;
  }
  function makeChannel(id: string, type: ChannelType.GuildText | ChannelType.GuildCategory) {
    const cache = new Collection<string, Overwrite>();
    return {
      id, guildId: ids.guild, type,
      isThread: () => false,
      permissionsFor(subject: { id: string; permissions: PermissionsBitField }) {
        const result = new PermissionsBitField(subject.permissions.bitfield);
        for (const overwrite of [cache.get(ids.guild), cache.get(subject.id)]) {
          if (overwrite) {
            result.remove(overwrite.deny.bitfield);
            result.add(overwrite.allow.bitfield);
          }
        }
        return result;
      },
      permissionOverwrites: {
        cache,
        async edit(userId: string, patch: Record<string, boolean | null>, options: { type: OverwriteType }) {
          counters.edits += 1;
          if (state.failEdit) throw Object.assign(new Error('Discord refused'), { code: 50013 });
          const previous = cache.get(userId);
          let allow = previous?.allow.bitfield ?? 0n;
          let deny = previous?.deny.bitfield ?? 0n;
          for (const [name, setting] of Object.entries(patch)) {
            const flag = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
            assert.equal(typeof flag, 'bigint');
            allow &= ~flag;
            deny &= ~flag;
            if (setting === true) allow |= flag;
            if (setting === false) deny |= flag;
          }
          cache.set(userId, { id: userId, type: options.type,
            allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) });
        },
        async delete(userId: string) { counters.deletes += 1; cache.delete(userId); },
        async set(values: Array<{ id: string; type: OverwriteType; allow: bigint; deny: bigint }>) {
          cache.clear();
          for (const value of values) cache.set(value.id, { ...value,
            allow: new PermissionsBitField(value.allow), deny: new PermissionsBitField(value.deny) });
        },
      },
      async send(payload: { content: string; allowedMentions: unknown }) { sent.push(payload); },
      async delete() {},
    };
  }
  const channel = makeChannel(ids.channel, ChannelType.GuildText);
  const category = makeChannel(ids.category, ChannelType.GuildCategory);
  const channels = new Map<string, ReturnType<typeof makeChannel>>([[channel.id, channel], [category.id, category]]);
  const guild = {
    id: ids.guild, name: '測試伺服器', ownerId: ids.other,
    roles: { everyone: { id: ids.guild }, async fetch() {} },
    members: {
      async fetch(options: { user: string; force: boolean }) {
        assert.equal(options.force, true);
        const result = members.get(options.user);
        assert.ok(result, `Unknown member ${options.user}`);
        return result;
      },
      async fetchMe() { return bot; },
    },
    channels: {
      async fetch(id: string) { return channels.get(id) ?? null; },
      async create(options: { permissionOverwrites: Array<{ id: string; type: number; allow: bigint; deny: bigint }>; parent: string }) {
        counters.creates += 1;
        created.push(options);
        const result = makeChannel(ids.created, ChannelType.GuildText);
        channels.set(result.id, result);
        return result;
      },
    },
  };
  for (const value of members.values()) value.guild = guild;
  const message = {
    async awaitMessageComponent(options: { filter: (value: { user: { id: string }; customId: string }) => boolean }) {
      if (state.confirmation === 'timeout') throw { code: 'InteractionCollectorError' };
      const customId = state.confirmation === 'confirm' ? `subarea:kick:${ids.interaction}` : `subarea:cancel:${ids.interaction}`;
      assert.equal(options.filter({ user: { id: ids.other }, customId }), false);
      assert.equal(options.filter({ user: { id: ids.actor }, customId }), true);
      return { customId, async update(payload: Edit) { replies.push(payload); state.onConfirmation(); } };
    },
  };
  const command = {
    id: ids.interaction, guildId: ids.guild, channelId: ids.channel, guild, user: { id: ids.actor },
    options: {
      getSubcommand: () => state.action,
      getUser: () => target.user,
      getString: (name: string) => name === 'type' || name === 'channel-id' ? null : name === 'name' ? '我的子區' : name === 'reason' ? '請遵守子區規則' : name === 'audience' ? 'everyone' : state.message,
      getRole: () => ({ id: ids.role }),
      getChannel: () => channel,
    },
    async editReply(payload: Edit) { replies.push(payload); return message; },
  } as unknown as ChatInputCommandInteraction<'cached'>;
  if (registered) store.setSubarea(ids.guild, ids.channel, ids.actor);
  return {
    command, actor, bot, target, channel, category, channels, guild, state, counters, replies, sent, created,
    run: () => handleSubareaCommand(command, store),
    finalReply: () => replies.at(-1)?.content ?? '',
  };
}

test('restriction computation combines mute and kick while preserving unrelated current permissions', () => {
  const originalAllow = PermissionFlagsBits.SendMessages | PermissionFlagsBits.AttachFiles;
  const originalDeny = PermissionFlagsBits.AddReactions;
  const currentAllow = PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.ViewChannel;
  const active = computeRestrictionPermissions(currentAllow, 0n, String(originalAllow), String(originalDeny), true, true);
  assert.equal(active.deny & MANAGED_PERMISSION_BITS, MANAGED_PERMISSION_BITS);
  assert.equal(active.allow & MANAGED_PERMISSION_BITS, 0n);
  assert.ok(active.allow & PermissionFlagsBits.EmbedLinks);
  const restored = computeRestrictionPermissions(active.allow, active.deny, String(originalAllow), String(originalDeny), false, false);
  assert.equal(restored.allow & MANAGED_PERMISSION_BITS, PermissionFlagsBits.SendMessages);
  assert.equal(restored.deny & MANAGED_PERMISSION_BITS, PermissionFlagsBits.AddReactions);
  assert.ok(restored.allow & PermissionFlagsBits.EmbedLinks);
  assert.equal(restored.removeOverwrite, false);
});

test('restoring an absent original overwrite removes it only when no unrelated bits remain', () => {
  assert.equal(computeRestrictionPermissions(0n, MUTE_PERMISSION_BITS, null, null, false, false).removeOverwrite, true);
  const permissions = computeRestrictionPermissions(PermissionFlagsBits.AttachFiles, MUTE_PERMISSION_BITS, null, null, false, false);
  assert.equal(permissions.removeOverwrite, false);
  assert.equal(permissions.allow, PermissionFlagsBits.AttachFiles);
  assert.equal(permissions.deny, 0n);
});

test('mute then kick then separate reversals restore an originally absent member overwrite', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    await f.run();
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target)?.originalDeny, null);
    assert.equal(f.channel.permissionOverwrites.cache.get(ids.target)?.deny.bitfield, MUTE_PERMISSION_BITS);
    f.state.action = 'kick';
    await f.run();
    const combined = store.getSubareaRestriction(ids.guild, ids.channel, ids.target);
    assert.equal(combined?.originalAllow, null);
    assert.equal(combined?.originalDeny, null, 'a null baseline must not be replaced with the active mute overwrite');
    assert.equal(combined?.muted, true);
    assert.equal(combined?.kicked, true);
    assert.equal(f.channel.permissionOverwrites.cache.get(ids.target)?.deny.bitfield, MANAGED_PERMISSION_BITS);
    f.state.action = 'unmute';
    await f.run();
    assert.equal(f.channel.permissionOverwrites.cache.get(ids.target)?.deny.bitfield, KICK_PERMISSION_BITS);
    f.state.action = 'unkick';
    await f.run();
    assert.equal(f.channel.permissionOverwrites.cache.has(ids.target), false);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target), null);
    assert.equal(f.counters.kicks, 0);
    assert.equal(f.counters.timeouts, 0);
    assert.deepEqual(store.listCases(ids.guild).map((entry) => entry.action), ['subarea-unkick', 'subarea-unmute', 'subarea-kick', 'subarea-mute']);
  } finally { store.close(); }
});

test('local kick changes only member ViewChannel and never invokes server kick or timeout', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'kick');
    await f.run();
    const overwrite = f.channel.permissionOverwrites.cache.get(ids.target);
    assert.equal(overwrite?.deny.bitfield, PermissionFlagsBits.ViewChannel);
    assert.equal(f.counters.kicks, 0);
    assert.equal(f.counters.timeouts, 0);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target)?.kicked, true);
    assert.match(f.finalReply(), /禁止.*查看及進入本子區/);
  } finally { store.close(); }
});

test('unrelated permissions changed during a mute survive its removal', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    await f.run();
    f.channel.permissionOverwrites.cache.get(ids.target)!.allow.add(PermissionFlagsBits.AttachFiles);
    f.state.action = 'unmute';
    await f.run();
    const overwrite = f.channel.permissionOverwrites.cache.get(ids.target);
    assert.equal(overwrite?.allow.bitfield, PermissionFlagsBits.AttachFiles);
    assert.equal(overwrite?.deny.bitfield, 0n);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target), null);
  } finally { store.close(); }
});

test('non-owners cannot moderate another registered channel or an unregistered channel', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    store.setSubarea(ids.guild, ids.channel, ids.other);
    await assert.rejects(f.run(), /只有此子區建立者/);
    store.deleteSubarea(ids.guild, ids.channel);
    await assert.rejects(f.run(), /不是已登記的子區/);
    assert.equal(f.counters.edits, 0);
    assert.deepEqual(store.listCases(ids.guild), []);
  } finally { store.close(); }
});

test('native administrators can moderate but cannot use creator-only tag commands', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    store.setSubarea(ids.guild, ids.channel, ids.other);
    f.actor.permissions.add(PermissionFlagsBits.Administrator);
    await f.run();
    assert.equal(f.counters.edits, 1);
    for (const action of ['tag', 'role-tag', 'announce']) {
      f.state.action = action;
      await assert.rejects(f.run(), /只有目前子區的建立者/);
    }
    assert.equal(f.sent.length, 0);
  } finally { store.close(); }
});

test('owner tag messages permit only the explicit user mention', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'tag');
    await f.run();
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0]?.allowedMentions, { parse: [], users: [ids.target] });
    assert.match(f.sent[0]?.content ?? '', /@everyone/);
    assert.equal(store.listCases(ids.guild)[0]?.action, 'subarea-tag');
  } finally { store.close(); }
});

test('a failed channel permission edit rolls back the persisted new restriction', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    f.state.failEdit = true;
    await assert.rejects(f.run(), { code: 50013 });
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target), null);
    assert.equal(f.channel.permissionOverwrites.cache.has(ids.target), false);
    assert.deepEqual(store.listCases(ids.guild), []);
  } finally { store.close(); }
});

test('a failed second restriction restores the existing mute and its original baseline', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    await f.run();
    f.state.action = 'kick';
    f.state.failEdit = true;
    await assert.rejects(f.run(), { code: 50013 });
    const restriction = store.getSubareaRestriction(ids.guild, ids.channel, ids.target);
    assert.equal(restriction?.muted, true);
    assert.equal(restriction?.kicked, false);
    assert.equal(restriction?.originalAllow, null);
    assert.equal(restriction?.originalDeny, null);
    assert.equal(f.channel.permissionOverwrites.cache.get(ids.target)?.deny.bitfield, MUTE_PERMISSION_BITS);
    assert.deepEqual(store.listCases(ids.guild).map((entry) => entry.action), ['subarea-mute']);
  } finally { store.close(); }
});

test('native administrators are protected from creator-issued local restrictions', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    f.target.permissions.add(PermissionFlagsBits.Administrator);
    await assert.rejects(f.run(), /無法限制.*伺服器管理者/);
    assert.equal(f.counters.edits, 0);
    assert.equal(f.counters.notifications, 0);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target), null);
  } finally { store.close(); }
});

test('owner transfer during local kick confirmation prevents any restriction', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'kick');
    f.state.onConfirmation = () => { store.setSubarea(ids.guild, ids.channel, ids.other); };
    await assert.rejects(f.run(), /只有此子區建立者/);
    assert.equal(f.counters.edits, 0);
    assert.equal(f.counters.notifications, 0);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target), null);
  } finally { store.close(); }
});

test('owner transfer during punishment DM prevents restriction after the awaited notification', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    f.state.onNotification = () => { store.setSubarea(ids.guild, ids.channel, ids.other); };
    await assert.rejects(f.run(), /只有此子區建立者/);
    assert.equal(f.counters.edits, 0);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target), null);
  } finally { store.close(); }
});

test('creation requires an explicitly configured category before creating any channel', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'create', false);
    await assert.rejects(f.run(), /尚未開放建立子區/);
    assert.equal(f.counters.creates, 0);
  } finally { store.close(); }
});

test('new channel mention policy denies ordinary members and role overrides while allowing creator and bot', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'create', false);
    store.updateSettings(ids.guild, { subareaCategoryId: ids.category });
    f.category.permissionOverwrites.cache.set(ids.role, {
      id: ids.role, type: OverwriteType.Role,
      allow: new PermissionsBitField([PermissionFlagsBits.MentionEveryone, PermissionFlagsBits.AttachFiles]),
      deny: new PermissionsBitField(),
    });
    await f.run();
    assert.equal(f.counters.creates, 1);
    assert.equal(store.getSubarea(ids.guild, ids.created)?.ownerId, ids.actor);
    const overwrites = new Map(f.created[0]!.permissionOverwrites.map((entry) => [entry.id, entry]));
    for (const id of [ids.guild, ids.role]) {
      assert.equal(overwrites.get(id)!.allow & PermissionFlagsBits.MentionEveryone, 0n);
      assert.ok(overwrites.get(id)!.deny & PermissionFlagsBits.MentionEveryone);
    }
    assert.ok(overwrites.get(ids.actor)!.allow & PermissionFlagsBits.MentionEveryone);
    assert.equal(overwrites.get(ids.actor)!.allow & PermissionFlagsBits.ManageRoles, 0n);
    assert.ok(overwrites.get(ids.bot)!.allow & PermissionFlagsBits.MentionEveryone);
    assert.ok(overwrites.get(ids.role)!.allow & PermissionFlagsBits.AttachFiles);
  } finally { store.close(); }
});

test('reconciliation applies saved restrictions after a crash without invoking global moderation', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    store.setSubareaRestriction({ guildId: ids.guild, channelId: ids.channel, userId: ids.target,
      muted: true, kicked: false, originalAllow: null, originalDeny: null,
      moderatorId: ids.actor, reason: '重新啟動前已記錄' });
    const client = { user: { id: ids.bot }, guilds: { async fetch() { return f.guild; } } } as unknown as Client;
    await reconcileSubareaRestrictions(client, store);
    assert.equal(f.channel.permissionOverwrites.cache.get(ids.target)?.deny.bitfield, MUTE_PERMISSION_BITS);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target)?.muted, true);
    assert.equal(f.counters.kicks, 0);
    assert.equal(f.counters.timeouts, 0);
  } finally { store.close(); }
});

test('reconciliation completes a saved removal after a crash and clears its durable row', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'unmute');
    f.channel.permissionOverwrites.cache.set(ids.target, { id: ids.target, type: OverwriteType.Member,
      allow: new PermissionsBitField(), deny: new PermissionsBitField(MUTE_PERMISSION_BITS) });
    store.setSubareaRestriction({ guildId: ids.guild, channelId: ids.channel, userId: ids.target,
      muted: false, kicked: false, originalAllow: null, originalDeny: null,
      moderatorId: ids.actor, reason: '已要求解除，尚未送達 Discord' });
    const client = { user: { id: ids.bot }, guilds: { async fetch() { return f.guild; } } } as unknown as Client;
    await reconcileSubareaRestrictions(client, store);
    assert.equal(f.channel.permissionOverwrites.cache.has(ids.target), false);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target), null);
  } finally { store.close(); }
});

test('local delegates can moderate within their assigned area but cannot pin, notify or re-delegate', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    store.setSubarea(ids.guild, ids.channel, ids.other);
    store.setSubareaDelegate(ids.guild, ids.channel, ids.actor, ids.other);
    f.target.roles.highest.position = 10;
    await f.run();
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target)?.muted, true);
    for (const action of ['pin', 'unpin', 'tag', 'role-tag', 'announce', 'delegate', 'delete']) {
      f.state.action = action;
      await assert.rejects(f.run(), /只有/);
    }
    assert.equal(f.sent.length, 0);
    assert.equal(f.counters.kicks, 0);
    assert.equal(f.counters.timeouts, 0);
  } finally { store.close(); }
});

test('revoking a local delegate during a punishment notice prevents text-channel restriction', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    store.setSubarea(ids.guild, ids.channel, ids.other);
    store.setSubareaDelegate(ids.guild, ids.channel, ids.actor, ids.other);
    f.state.onNotification = () => { store.deleteSubareaDelegate(ids.guild, ids.channel, ids.actor); };
    await assert.rejects(f.run(), /只有/);
    assert.equal(f.counters.edits, 0);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target), null);
  } finally { store.close(); }
});

test('lock then mute and unmute retains the lock until unlock and restores an absent member overwrite', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'lock');
    await f.run();
    assert.ok(store.getSubareaLock(ids.guild, ids.channel));
    f.state.action = 'mute';
    await f.run();
    f.state.action = 'unmute';
    await f.run();
    assert.equal(f.channel.permissionOverwrites.cache.get(ids.target)!.deny.bitfield & MUTE_PERMISSION_BITS, MUTE_PERMISSION_BITS);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target)?.muted, false);
    f.state.action = 'unlock';
    await f.run();
    assert.equal(store.getSubareaLock(ids.guild, ids.channel), null);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target), null);
    assert.equal(f.channel.permissionOverwrites.cache.has(ids.target), false);
  } finally { store.close(); }
});

test('a mute cleared while locked is not resurrected when the text area unlocks', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'mute');
    await f.run();
    f.state.action = 'lock';
    await f.run();
    f.state.action = 'unmute';
    await f.run();
    f.state.action = 'unlock';
    await f.run();
    assert.equal(f.channel.permissionOverwrites.cache.has(ids.target), false);
    assert.equal(store.getSubareaRestriction(ids.guild, ids.channel, ids.target), null);
  } finally { store.close(); }
});

test('unlock retains an active local mute and kick until each is separately reversed', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture(store, 'lock');
    await f.run();
    f.state.action = 'mute';
    await f.run();
    f.state.action = 'kick';
    await f.run();
    f.state.action = 'unlock';
    await f.run();
    assert.equal(f.channel.permissionOverwrites.cache.get(ids.target)?.deny.bitfield, MANAGED_PERMISSION_BITS);
    f.state.action = 'unmute';
    await f.run();
    assert.equal(f.channel.permissionOverwrites.cache.get(ids.target)?.deny.bitfield, KICK_PERMISSION_BITS);
    f.state.action = 'unkick';
    await f.run();
    assert.equal(f.channel.permissionOverwrites.cache.has(ids.target), false);
  } finally { store.close(); }
});
