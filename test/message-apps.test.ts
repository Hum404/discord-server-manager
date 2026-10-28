import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChannelType, MessageFlags, PermissionFlagsBits as P, PermissionsBitField, type Interaction,
} from 'discord.js';
import { handleInteraction } from '../src/bot.js';
import { MESSAGE_APP_DELETE_NAME, MESSAGE_APP_PIN_NAME } from '../src/commands.js';
import { Store } from '../src/store.js';

const ids = {
  guild: '620000000000000001', actor: '620000000000000002', bot: '620000000000000003',
  delegate: '620000000000000004', admin: '620000000000000005', other: '620000000000000006',
  channel: '620000000000000007', message: '620000000000000008', interaction: '620000000000000009',
  otherGuild: '620000000000000010',
};
type Payload = {
  content?: string; flags?: number; allowedMentions?: unknown;
  components?: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>;
};
type FixtureOptions = { managed?: boolean; type?: ChannelType; commandName?: string };

function fixture(store: Store, options: FixtureOptions = {}) {
  const state = {
    actorId: ids.actor, commandName: options.commandName ?? MESSAGE_APP_PIN_NAME,
    cached: true, confirmation: 'confirm' as 'confirm' | 'cancel' | 'timeout',
    onConfirmation: () => {}, onMessageFetch: (_count: number) => {},
    fetchError: null as number | null,
    privateMembers: new Set<string>([ids.actor, ids.delegate]),
  };
  const counters = { pins: 0, unpins: 0, deletions: 0, fetches: 0, confirmations: 0, contentReads: 0 };
  const replies: Payload[] = [];
  const deferred: Payload[] = [];
  const fetches: Array<{ message: string; force: boolean; cache: boolean }> = [];
  const base = P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.SendMessagesInThreads;
  const guild = {
    id: ids.guild, ownerId: ids.admin,
    roles: { async fetch() {} },
    members: {
      async fetch(options: { user: string; force: boolean }) {
        assert.equal(options.force, true);
        const member = members.get(options.user);
        assert.ok(member, `Unexpected member ${options.user}`);
        return member;
      },
      async fetchMe() { return bot; },
    },
    channels: { async fetch(channelId: string) { assert.equal(channelId, ids.channel); return channel; } },
  };
  function member(id: string, permissions = base, isBot = false) {
    return { id, guild, permissions: new PermissionsBitField(permissions), user: { id, bot: isBot } };
  }
  const actor = member(ids.actor);
  const delegate = member(ids.delegate);
  const admin = member(ids.admin, P.Administrator);
  const bot = member(ids.bot, PermissionsBitField.All, true);
  const members = new Map<string, ReturnType<typeof member>>([
    [actor.id, actor], [delegate.id, delegate], [admin.id, admin], [bot.id, bot],
  ]);
  function forbidContent(): never {
    counters.contentReads++;
    throw new Error('Message content must not be read');
  }
  const message = {
    id: ids.message, guildId: ids.guild, channelId: ids.channel, pinned: false,
    get content(): string { return forbidContent(); },
    async pin() { counters.pins++; message.pinned = true; },
    async unpin() { counters.unpins++; message.pinned = false; },
    async delete() { counters.deletions++; },
  };
  const target = {
    id: ids.message, guildId: ids.guild, channelId: ids.channel,
    pinned: false,
    get content(): string { return forbidContent(); },
  };
  const channel = {
    id: ids.channel, guildId: ids.guild, guild,
    type: options.type ?? ChannelType.GuildText, ownerId: ids.actor as string,
    permissionsFor(subject: { permissions: PermissionsBitField }) { return subject.permissions; },
    members: { async fetch(options: { member: string; force: boolean; cache: boolean }) {
      assert.equal(options.force, true); assert.equal(options.cache, false);
      if (!state.privateMembers.has(options.member)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
      return { id: options.member };
    } },
    messages: { async fetch(options: { message: string; force: boolean; cache: boolean }) {
      assert.equal(options.message, ids.message);
      assert.equal(options.force, true);
      assert.equal(options.cache, false);
      fetches.push({ ...options }); counters.fetches++;
      state.onMessageFetch(counters.fetches);
      if (state.fetchError !== null) throw Object.assign(new Error('Transport fetch failed'), { code: state.fetchError });
      return message;
    } },
  };
  const command = {
    id: ids.interaction, guildId: ids.guild, channelId: ids.channel, guild,
    get commandName() { return state.commandName; },
    get user() { return { id: state.actorId }; },
    targetId: ids.message, targetMessage: target,
    deferred: false, replied: false,
    isChatInputCommand: () => false,
    isMessageContextMenuCommand: () => true,
    isRepliable: () => true,
    inCachedGuild: () => state.cached,
    async deferReply(payload: Payload) { deferred.push(payload); command.deferred = true; },
    async reply(payload: Payload) { replies.push(payload); command.replied = true; },
    async editReply(payload: Payload) {
      replies.push(payload);
      return { async awaitMessageComponent(options: {
        time: number; filter(value: { user: { id: string }; customId: string }): boolean;
      }) {
        counters.confirmations++;
        assert.equal(options.time, 30_000);
        if (state.confirmation === 'timeout') throw { code: 'InteractionCollectorError' };
        const buttons = payload.components?.[0]?.toJSON().components;
        const yes = buttons?.[0]?.custom_id;
        const no = buttons?.[1]?.custom_id;
        assert.ok(yes); assert.ok(no);
        assert.equal(options.filter({ user: { id: ids.other }, customId: yes }), false);
        assert.equal(options.filter({ user: { id: state.actorId }, customId: 'forged-button' }), false);
        assert.equal(options.filter({ user: { id: state.actorId }, customId: yes }), true);
        return { customId: state.confirmation === 'cancel' ? no : yes,
          async update(payload: Payload) { replies.push(payload); state.onConfirmation(); } };
      } };
    },
  };
  if (options.managed !== false) store.setSubarea(ids.guild, ids.channel, ids.actor);
  return { state, counters, actor, delegate, admin, bot, guild, channel, message, target, fetches,
    replies, deferred, command,
    run: () => handleInteraction(command as unknown as Interaction, store),
    final: () => replies.at(-1)?.content ?? '',
  };
}

function withStore(run: (store: Store) => Promise<void>) {
  return async () => {
    const store = new Store(':memory:');
    try { await run(store); } finally { store.close(); }
  };
}

test('message APP routing toggles the selected managed message using fresh state and private replies', withStore(async (store) => {
  const f = fixture(store);
  await f.run();
  assert.equal(f.counters.pins, 1);
  assert.equal(f.message.pinned, true);
  // Discord's interaction target can remain stale; fresh fetch controls the toggle.
  assert.equal(f.target.pinned, false);
  await f.run();
  assert.equal(f.counters.unpins, 1);
  assert.equal(f.message.pinned, false);
  assert.deepEqual(f.deferred, [{ flags: MessageFlags.Ephemeral }, { flags: MessageFlags.Ephemeral }]);
  assert.equal(f.counters.contentReads, 0);
  assert.ok(f.fetches.every((item) => item.message === ids.message && item.force && !item.cache));
  assert.deepEqual(store.listCases(ids.guild).map((item) => item.action), ['subarea-unpin', 'subarea-pin']);
  for (const reply of f.replies) if (reply.allowedMentions) assert.deepEqual(reply.allowedMentions, { parse: [] });
}));

test('managed-message pin remains creator only even for delegates and native administrators', withStore(async (store) => {
  const f = fixture(store);
  store.setSubareaDelegate(ids.guild, ids.channel, ids.delegate, ids.actor);
  for (const actorId of [ids.delegate, ids.admin]) {
    f.state.actorId = actorId;
    await f.run();
    assert.match(f.final(), /只有目前子區建立者/);
  }
  assert.equal(f.counters.pins, 0);
  assert.equal(f.counters.fetches, 0);
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('a local delegate can delete the selected managed message only after actor-bound confirmation', withStore(async (store) => {
  const f = fixture(store, { commandName: MESSAGE_APP_DELETE_NAME });
  store.setSubareaDelegate(ids.guild, ids.channel, ids.delegate, ids.actor);
  f.state.actorId = ids.delegate;
  await f.run();
  assert.equal(f.counters.confirmations, 1);
  assert.equal(f.counters.deletions, 1);
  assert.equal(store.listCases(ids.guild)[0]?.action, 'subarea-delete-message');
}));

test('revoking a delegate during APP confirmation aborts deletion without a success audit', withStore(async (store) => {
  const f = fixture(store, { commandName: MESSAGE_APP_DELETE_NAME });
  store.setSubareaDelegate(ids.guild, ids.channel, ids.delegate, ids.actor);
  f.state.actorId = ids.delegate;
  f.state.onConfirmation = () => { store.deleteSubareaDelegate(ids.guild, ids.channel, ids.delegate); };
  await f.run();
  assert.match(f.final(), /只有子區建立者、協管/);
  assert.equal(f.counters.deletions, 0);
  assert.deepEqual(store.listCases(ids.guild), []);
}));

for (const type of [ChannelType.GuildText, ChannelType.GuildAnnouncement]) {
  test(`ordinary channel ${type} requires native PinMessages before pinning`, withStore(async (store) => {
    const f = fixture(store, { managed: false, type });
    await f.run();
    assert.match(f.final(), /置頂訊息權限/);
    assert.equal(f.counters.pins, 0);
    f.actor.permissions.add(P.PinMessages);
    await f.run();
    assert.equal(f.counters.pins, 1);
    assert.equal(store.listCases(ids.guild)[0]?.action, 'message-pin');
  }));

  test(`ordinary channel ${type} requires native ManageMessages before confirmed deletion`, withStore(async (store) => {
    const f = fixture(store, { managed: false, type, commandName: MESSAGE_APP_DELETE_NAME });
    await f.run();
    assert.match(f.final(), /管理訊息權限/);
    assert.equal(f.counters.confirmations, 0);
    f.actor.permissions.add(P.ManageMessages);
    await f.run();
    assert.equal(f.counters.deletions, 1);
    assert.equal(store.listCases(ids.guild)[0]?.action, 'message-delete');
  }));
}

test('a Bot clear grant alone cannot authorize ordinary-channel APP message deletion', withStore(async (store) => {
  const f = fixture(store, { managed: false, commandName: MESSAGE_APP_DELETE_NAME });
  store.setGrant(ids.guild, ids.actor, 'clear', ids.admin);
  await f.run();
  assert.match(f.final(), /管理訊息權限/);
  assert.equal(f.counters.deletions, 0);
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('missing Bot PinMessages blocks an otherwise authorized APP operation', withStore(async (store) => {
  const f = fixture(store);
  f.bot.permissions.remove([P.Administrator, P.PinMessages]);
  await f.run();
  assert.match(f.final(), /機器人缺少.*置頂訊息/);
  assert.equal(f.counters.pins, 0);
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('missing Bot ManageMessages prevents ordinary-channel deletion before confirmation', withStore(async (store) => {
  const f = fixture(store, { managed: false, commandName: MESSAGE_APP_DELETE_NAME });
  f.actor.permissions.add(P.ManageMessages);
  f.bot.permissions.remove([P.Administrator, P.ManageMessages]);
  await f.run();
  assert.match(f.final(), /機器人缺少.*管理訊息/);
  assert.equal(f.counters.confirmations, 0);
  assert.equal(f.counters.deletions, 0);
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('interaction targets from another guild, channel or message ID are rejected before fetch', withStore(async (store) => {
  for (const field of ['guildId', 'channelId', 'id'] as const) {
    const f = fixture(store);
    f.target[field] = ids.other;
    await f.run();
    assert.match(f.final(), /目前伺服器及頻道/);
    assert.equal(f.counters.fetches, 0);
    assert.equal(f.counters.pins, 0);
  }
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('fresh transport results must match selected guild, channel and message identity', withStore(async (store) => {
  for (const field of ['guildId', 'channelId', 'id'] as const) {
    const f = fixture(store, { managed: false });
    f.actor.permissions.add(P.PinMessages);
    f.message[field] = ids.other;
    await f.run();
    assert.match(f.final(), /目前伺服器及頻道/);
    assert.equal(f.counters.pins, 0);
  }
  assert.deepEqual(store.listCases(ids.guild), []);
}));

for (const managed of [true, false]) {
  for (const confirmation of ['cancel', 'timeout'] as const) {
    test(`APP deletion ${confirmation} leaves ${managed ? 'managed' : 'ordinary'} channel content and audit unchanged`, withStore(async (store) => {
      const f = fixture(store, { managed, commandName: MESSAGE_APP_DELETE_NAME });
      f.actor.permissions.add(P.ManageMessages);
      f.state.confirmation = confirmation;
      await f.run();
      assert.match(f.final(), confirmation === 'cancel' ? /取消/ : /逾時/);
      assert.equal(f.counters.deletions, 0);
      assert.deepEqual(store.listCases(ids.guild), []);
    }));
  }
}

test('ordinary-channel native permission revocation during confirmation prevents deletion', withStore(async (store) => {
  const f = fixture(store, { managed: false, commandName: MESSAGE_APP_DELETE_NAME });
  f.actor.permissions.add(P.ManageMessages);
  f.state.onConfirmation = () => { f.actor.permissions.remove(P.ManageMessages); };
  await f.run();
  assert.match(f.final(), /管理訊息權限/);
  assert.equal(f.counters.deletions, 0);
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('a message deleted before the fresh fetch is reported without mutation or success audit', withStore(async (store) => {
  for (const managed of [true, false]) {
    const f = fixture(store, { managed });
    f.actor.permissions.add(P.PinMessages);
    f.state.fetchError = 10008;
    await f.run();
    assert.match(f.final(), /訊息已被刪除/);
    assert.equal(f.counters.pins, 0);
  }
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('human-created forum posts are adopted for creator-only APP pinning', withStore(async (store) => {
  const f = fixture(store, { managed: false, type: ChannelType.PublicThread });
  assert.equal(store.getSubarea(ids.guild, ids.channel), null);
  await f.run();
  assert.equal(store.getSubarea(ids.guild, ids.channel)?.ownerId, ids.actor);
  assert.equal(f.counters.pins, 1);
  assert.equal(store.listCases(ids.guild)[0]?.action, 'subarea-pin');
}));

test('private-thread membership removal during confirmation aborts APP deletion', withStore(async (store) => {
  const f = fixture(store, { type: ChannelType.PrivateThread, commandName: MESSAGE_APP_DELETE_NAME });
  f.state.onConfirmation = () => { f.state.privateMembers.delete(ids.actor); };
  await f.run();
  assert.match(f.final(), /私密討論串/);
  assert.equal(f.counters.deletions, 0);
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('native APP deletion in an unregistered private thread also rechecks membership after confirmation', withStore(async (store) => {
  const f = fixture(store, { managed: false, type: ChannelType.PrivateThread, commandName: MESSAGE_APP_DELETE_NAME });
  f.channel.ownerId = ids.bot; // Posts created by another Bot are not auto-adopted.
  f.actor.permissions.add(P.ManageMessages);
  f.state.onConfirmation = () => { f.state.privateMembers.delete(ids.actor); };
  await f.run();
  assert.match(f.final(), /私密討論串/);
  assert.equal(store.getSubarea(ids.guild, ids.channel), null);
  assert.equal(f.counters.deletions, 0);
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('managed ownership changed during the final message fetch prevents a queued pin', withStore(async (store) => {
  const f = fixture(store);
  f.state.onMessageFetch = (count) => { if (count === 2) store.setSubarea(ids.guild, ids.channel, ids.admin); };
  await f.run();
  assert.match(f.final(), /只有目前子區建立者/);
  assert.equal(f.counters.pins, 0);
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('ordinary native permission changed during the final message fetch prevents pinning', withStore(async (store) => {
  const f = fixture(store, { managed: false });
  f.actor.permissions.add(P.PinMessages);
  f.state.onMessageFetch = (count) => { if (count === 2) f.actor.permissions.remove(P.PinMessages); };
  await f.run();
  assert.match(f.final(), /置頂訊息權限/);
  assert.equal(f.counters.pins, 0);
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('native APP authorization refetches REST member snapshots after the final message lookup', withStore(async (store) => {
  const f = fixture(store, { managed: false });
  f.actor.permissions.add(P.PinMessages);
  const fetchMember = f.guild.members.fetch;
  let revoked = false;
  f.guild.members.fetch = async (options) => {
    const member = await fetchMember(options);
    if (options.user !== ids.actor) return member;
    const permissions = new PermissionsBitField(member.permissions.bitfield);
    if (revoked) permissions.remove(P.PinMessages);
    // Old REST snapshots remain unchanged; Gateway updates need not have arrived yet.
    return { ...member, permissions };
  };
  f.state.onMessageFetch = (count) => { if (count === 2) revoked = true; };
  await f.run();
  assert.match(f.final(), /置頂訊息權限/);
  assert.equal(f.counters.pins, 0);
  assert.equal(f.actor.permissions.has(P.PinMessages), true);
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('message APP audit shows this guild case #1 even after other guild cases exist', withStore(async (store) => {
  for (let i = 0; i < 3; i++) store.addCase({ guildId: ids.otherGuild, userId: ids.actor,
    action: 'warn', moderatorId: ids.admin, reason: 'Other guild' });
  const f = fixture(store);
  await f.run();
  assert.match(f.final(), /本服案件 #1/);
  assert.equal(store.listCases(ids.guild)[0]?.caseNumber, 1);
  assert.equal(store.listCases(ids.guild)[0]?.id, 4);
}));

test('APP message actions require a cached guild and acknowledge privately outside it', withStore(async (store) => {
  const f = fixture(store);
  f.state.cached = false;
  await f.run();
  assert.equal(f.deferred.length, 0);
  assert.equal(f.replies[0]?.flags, MessageFlags.Ephemeral);
  assert.match(f.final(), /伺服器內/);
  assert.equal(f.counters.fetches, 0);
  assert.deepEqual(store.listCases(ids.guild), []);
}));
