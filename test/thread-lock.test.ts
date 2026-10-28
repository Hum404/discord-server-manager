import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ChannelType, PermissionFlagsBits as P, PermissionsBitField,
  type ChatInputCommandInteraction, type Client, type Message, type MessageReaction, type User,
} from 'discord.js';
import { Store } from '../src/store.js';
import { handleSubareaTools, reconcileSubareaLocks } from '../src/subarea-tools.js';
import { handleSubareaThreadMessage, handleSubareaThreadReaction } from '../src/subarea-threads.js';

const id = {
  guild: '740000000000000001', owner: '740000000000000002', bot: '740000000000000003',
  member: '740000000000000004', admin: '740000000000000005', manager: '740000000000000006',
  guildOwner: '740000000000000007', parent: '740000000000000008', interaction: '740000000000000009',
};
let sequence = 100;
type FakeMember = {
  id: string; guild: unknown; user: { id: string; bot: boolean }; permissions: PermissionsBitField;
  send(payload: unknown): Promise<void>; timeout(): Promise<void>; kick(): Promise<void>;
};

function fixture(store: Store, channelId = String(740000000000001000n + BigInt(sequence++))) {
  const state = { action: 'lock', actorId: id.owner as string, failEdit: false,
    onMemberFetch: (_userId: string) => {} };
  const counters = { edits: 0, deletedMessages: 0, removedReactions: 0, notices: 0,
    guildTimeouts: 0, guildKicks: 0, overwriteAccesses: 0 };
  const replies: Array<{ content?: string }> = [];
  const members = new Map<string, FakeMember>();
  const normal = P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.SendMessagesInThreads
    | P.UseApplicationCommands | P.AddReactions;
  function member(userId: string, permissionBits = normal, bot = false) {
    const result: FakeMember = {
      id: userId, guild: undefined, user: { id: userId, bot }, permissions: new PermissionsBitField(permissionBits),
      async send() { counters.notices++; },
      async timeout() { counters.guildTimeouts++; },
      async kick() { counters.guildKicks++; },
    };
    members.set(userId, result);
    return result;
  }
  const owner = member(id.owner);
  const ordinary = member(id.member);
  const bot = member(id.bot, PermissionsBitField.All, true);
  const admin = member(id.admin, normal | P.Administrator);
  const manager = member(id.manager, normal | P.ManageGuild);
  const guildOwner = member(id.guildOwner);
  const parent = {
    id: id.parent, type: ChannelType.GuildForum, guildId: id.guild,
    permissionsFor(subject: FakeMember) { return subject.permissions; },
    get permissionOverwrites(): never {
      counters.overwriteAccesses++;
      throw new Error('Thread locking must not change parent channel permissions');
    },
  };
  const channel = {
    id: channelId, guildId: id.guild, guild: undefined as unknown,
    type: ChannelType.PublicThread, ownerId: id.owner, parentId: id.parent, parent,
    locked: false, archived: false, rateLimitPerUser: 0,
    permissionsFor(subject: FakeMember) { return subject.permissions; },
    members: { async fetch() { return { id: state.actorId }; } },
    get permissionOverwrites(): never {
      counters.overwriteAccesses++;
      throw new Error('Discord threads have no per-member permission overwrites');
    },
    async edit(options: { locked: boolean; archived: boolean }) {
      counters.edits++;
      if (state.failEdit) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      channel.locked = options.locked;
      channel.archived = options.archived;
    },
  };
  const guild = {
    id: id.guild, ownerId: id.guildOwner,
    roles: { async fetch() {} },
    members: {
      async fetch(options: { user: string; force: boolean }) {
        assert.equal(options.force, true);
        state.onMemberFetch(options.user);
        const result = members.get(options.user);
        assert.ok(result, `Unknown member ${options.user}`);
        return result;
      },
      async fetchMe() { return bot; },
    },
    channels: { async fetch(requestedId: string) {
      assert.equal(requestedId, channel.id);
      return channel;
    } },
  };
  channel.guild = guild;
  for (const entry of members.values()) entry.guild = guild;
  const command = {
    id: id.interaction, guild, guildId: id.guild, channelId: channel.id,
    get user() { return { id: state.actorId }; },
    options: { getSubcommand: () => state.action, getChannel: () => null, getString: () => null },
    async editReply(payload: { content?: string }) { replies.push(payload); },
  } as unknown as ChatInputCommandInteraction<'cached'>;
  store.setSubarea(id.guild, channel.id, owner.id);
  function message(author: FakeMember = ordinary): Message {
    return {
      id: '740000000000002001', guild, channel, author: author.user,
      async delete() { counters.deletedMessages++; },
    } as unknown as Message;
  }
  function reaction(author: FakeMember = ordinary): MessageReaction {
    return { message: message(author), users: { async remove(userId: string) {
      assert.equal(userId, author.id); counters.removedReactions++;
    } } } as unknown as MessageReaction;
  }
  return { state, counters, owner, ordinary, bot, admin, manager, guildOwner, members, channel, guild, command,
    replies, message, reaction,
    run: () => handleSubareaTools(command, store),
    ownerCanSend: () => !channel.archived && !channel.locked && owner.permissions.has(P.SendMessagesInThreads),
    mute(userId = ordinary.id) { store.setSubareaRestriction({ guildId: id.guild, channelId: channel.id, userId,
      muted: true, kicked: false, originalAllow: null, originalDeny: null,
      moderatorId: owner.id, reason: '個別禁言仍須保留' }); },
  };
}

function withStore(run: (store: Store) => Promise<void>) {
  return async () => {
    const store = new Store(':memory:');
    try { await run(store); } finally { store.close(); }
  };
}

test('thread lock preserves owner posting instead of archiving every member out of the thread', withStore(async (store) => {
  const f = fixture(store);
  f.channel.archived = true; f.channel.locked = true;
  assert.equal(f.ownerCanSend(), false, 'native archive and lock also block a normal thread creator');
  await f.run();
  assert.equal(f.ownerCanSend(), true);
  assert.equal(f.channel.archived, false);
  assert.equal(f.channel.locked, false);
  assert.ok(store.getSubareaLock(id.guild, f.channel.id));
  assert.equal(f.owner.permissions.has(P.ManageThreads), false);
  assert.equal(f.owner.permissions.has(P.ManageRoles), false);
  assert.equal(f.owner.permissions.has(P.Administrator), false);
  await handleSubareaThreadMessage(f.message(), store);
  assert.equal(f.counters.deletedMessages, 1);
  await handleSubareaThreadMessage(f.message(f.owner), store);
  assert.equal(f.counters.deletedMessages, 1);
  assert.equal(f.counters.overwriteAccesses, 0);
  assert.equal(f.counters.guildKicks, 0);
  assert.equal(f.counters.guildTimeouts, 0);
}));

test('thread lock exempts current owner, Bot and native server staff from reactive removal', withStore(async (store) => {
  const f = fixture(store);
  await f.run();
  for (const subject of [f.owner, f.bot, f.admin, f.manager, f.guildOwner]) {
    await handleSubareaThreadMessage(f.message(subject), store);
    await handleSubareaThreadReaction(f.reaction(subject), subject.user as User, store);
  }
  assert.equal(f.counters.deletedMessages, 0);
  assert.equal(f.counters.removedReactions, 0);
  await handleSubareaThreadReaction(f.reaction(), f.ordinary.user as User, store);
  assert.equal(f.counters.removedReactions, 1);
}));

test('unlock stops thread-wide restrictions but preserves explicit individual mutes', withStore(async (store) => {
  const f = fixture(store);
  f.mute();
  await f.run();
  f.state.action = 'unlock';
  await f.run();
  assert.equal(store.getSubareaLock(id.guild, f.channel.id), null);
  assert.equal(store.getSubareaRestriction(id.guild, f.channel.id, f.ordinary.id)?.muted, true);
  await handleSubareaThreadMessage(f.message(f.ordinary), store);
  assert.equal(f.counters.deletedMessages, 1);
  store.deleteSubareaRestriction(id.guild, f.channel.id, f.ordinary.id);
  await handleSubareaThreadMessage(f.message(f.ordinary), store);
  assert.equal(f.counters.deletedMessages, 1);
}));

test('legacy native thread locks can be unlocked without a saved Bot lock row', withStore(async (store) => {
  const f = fixture(store);
  f.channel.locked = true; f.channel.archived = true;
  f.state.action = 'unlock';
  assert.equal(store.getSubareaLock(id.guild, f.channel.id), null);
  await f.run();
  assert.equal(f.channel.locked, false);
  assert.equal(f.channel.archived, false);
  assert.equal(f.ownerCanSend(), true);
  assert.equal(store.listCases(id.guild)[0]?.action, 'subarea-unlock');
}));

test('thread native edit failure rolls back a newly persisted lock and does not audit success', withStore(async (store) => {
  const f = fixture(store);
  f.channel.locked = true; f.channel.archived = true; f.state.failEdit = true;
  await assert.rejects(f.run(), { code: 50013 });
  assert.equal(store.getSubareaLock(id.guild, f.channel.id), null);
  assert.equal(f.channel.locked, true);
  assert.deepEqual(store.listCases(id.guild), []);
}));

test('ordinary thread participants cannot unlock another creator registered area', withStore(async (store) => {
  const f = fixture(store);
  store.setSubareaLock(id.guild, f.channel.id, '[]', id.owner);
  f.state.action = 'unlock'; f.state.actorId = f.ordinary.id;
  await assert.rejects(f.run(), /建立者|協管|管理員/);
  assert.ok(store.getSubareaLock(id.guild, f.channel.id));
  assert.equal(f.counters.edits, 0);
}));

test('unlock during reactive member refresh prevents a pending thread-lock deletion', withStore(async (store) => {
  const f = fixture(store);
  store.setSubareaLock(id.guild, f.channel.id, '[]', id.owner);
  f.state.onMemberFetch = (userId) => {
    if (userId === f.ordinary.id) store.deleteSubareaLock(id.guild, f.channel.id);
  };
  await handleSubareaThreadMessage(f.message(), store);
  assert.equal(f.counters.deletedMessages, 0);
}));

test('thread locks survive database restart and continue exempting their creator', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-thread-lock-'));
  const path = join(directory, 'bot.sqlite');
  let store = new Store(path);
  try {
    const first = fixture(store);
    await first.run();
    store.close();
    store = new Store(path);
    const restarted = fixture(store, first.channel.id);
    assert.ok(store.getSubareaLock(id.guild, restarted.channel.id));
    await handleSubareaThreadMessage(restarted.message(), store);
    await handleSubareaThreadMessage(restarted.message(restarted.owner), store);
    assert.equal(restarted.counters.deletedMessages, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('startup lock reconciliation does not reopen a thread archived later by native staff', withStore(async (store) => {
  const f = fixture(store);
  store.setSubareaLock(id.guild, f.channel.id, '[]', id.owner);
  f.channel.archived = true; f.channel.locked = true;
  const client = { user: { id: id.bot }, guilds: { async fetch(guildId: string) {
    assert.equal(guildId, id.guild); return f.guild;
  } } } as unknown as Client;
  await reconcileSubareaLocks(client, store);
  assert.equal(f.channel.archived, true);
  assert.equal(f.channel.locked, true);
  assert.equal(f.counters.edits, 0);
  assert.ok(store.getSubareaLock(id.guild, f.channel.id));
}));
