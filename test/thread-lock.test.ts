import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ChannelType, PermissionFlagsBits as P, PermissionsBitField,
  type ChatInputCommandInteraction, type Client, type Guild, type Message, type MessageReaction, type User,
} from 'discord.js';
import { Store } from '../src/store.js';
import { changeSubareaLock, handleSubareaTools, managedAreaOperation, reconcileSubareaLocks } from '../src/subarea-tools.js';
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
  const state = { action: 'lock', actorId: id.owner as string, failEdit: false, failNotice: false, failDm: false,
    onMemberFetch: (_userId: string) => {}, onChannelFetch: () => {}, onRoleFetch: () => {}, onNotice: () => {} };
  const counters = { edits: 0, deletedMessages: 0, removedReactions: 0, notices: 0,
    guildTimeouts: 0, guildKicks: 0, overwriteAccesses: 0 };
  const replies: Array<{ content?: string }> = [];
  const publicNotices: unknown[] = [];
  const directNotices: Array<{ userId: string; payload: unknown }> = [];
  const transport: string[] = [];
  const members = new Map<string, FakeMember>();
  const normal = P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.SendMessagesInThreads
    | P.UseApplicationCommands | P.AddReactions;
  function member(userId: string, permissionBits = normal, bot = false) {
    const result: FakeMember = {
      id: userId, guild: undefined, user: { id: userId, bot }, permissions: new PermissionsBitField(permissionBits),
      async send(payload) {
        if (state.failDm) throw { code: 50007 };
        counters.notices++; directNotices.push({ userId, payload }); transport.push('dm');
      },
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
      transport.push(options.locked && options.archived ? 'lock' : 'unlock');
      return channel;
    },
    async send(payload: unknown) {
      if (state.failNotice) throw { code: 50013 };
      assert.equal(channel.archived, false, 'sending must not reopen an archived thread to announce its lock');
      state.onNotice();
      transport.push('notice'); publicNotices.push(payload);
      return { id: '740000000000003001', channelId, guildId: id.guild,
        async edit(value: unknown) { publicNotices.push(value); transport.push('notice-edit'); },
        async delete() { transport.push('notice-delete'); } };
    },
  };
  const guild = {
    id: id.guild, ownerId: id.guildOwner,
    roles: { async fetch() { state.onRoleFetch(); } },
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
      assert.equal(requestedId, channel.id); state.onChannelFetch(); return channel;
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
    return { id: '740000000000002001', guild, channel, author: author.user,
      async delete() { counters.deletedMessages++; } } as unknown as Message;
  }
  function reaction(author: FakeMember = ordinary): MessageReaction {
    return { message: message(author), users: { async remove(userId: string) {
      assert.equal(userId, author.id); counters.removedReactions++;
    } } } as unknown as MessageReaction;
  }
  return { state, counters, owner, ordinary, bot, admin, manager, guildOwner, members, channel, guild, command,
    replies, message, reaction, publicNotices, directNotices, transport,
    run: () => handleSubareaTools(command, store),
    recover: (lockId?: string) => changeSubareaLock({ guild: guild as unknown as Guild,
      userId: state.actorId, channelId: channel.id }, store, false, lockId),
    client: { user: { id: id.bot }, guilds: { async fetch(guildId: string) {
      assert.equal(guildId, id.guild); return guild;
    } } } as unknown as Client,
    mute(userId = ordinary.id) { store.setSubareaRestriction({ guildId: id.guild, channelId: channel.id, userId,
      muted: true, kicked: false, originalAllow: null, originalDeny: null,
      moderatorId: owner.id, reason: '個別禁言仍須保留' }); },
  };
}

function withStore(run: (store: Store) => Promise<void>) {
  return async () => { const store = new Store(':memory:'); try { await run(store); } finally { store.close(); } };
}

test('thread lock uses native archive and lock without granting creator native management permissions', withStore(async (store) => {
  const f = fixture(store);
  await f.run();
  assert.equal(f.channel.archived, true);
  assert.equal(f.channel.locked, true);
  const lock = store.getSubareaLock(id.guild, f.channel.id)!;
  assert.equal(lock.mode, 'thread-native'); assert.equal(lock.source, 'owner');
  assert.equal(lock.lockedBy, id.owner); assert.match(lock.lockId, /^[a-f0-9]{16}$/);
  assert.equal(f.owner.permissions.has(P.ManageThreads), false);
  assert.equal(f.owner.permissions.has(P.ManageRoles), false);
  assert.equal(f.owner.permissions.has(P.Administrator), false);
  assert.equal(f.counters.overwriteAccesses, 0);
  assert.equal(f.counters.guildKicks, 0); assert.equal(f.counters.guildTimeouts, 0);
  assert.equal(store.listCases(id.guild)[0]?.action, 'subarea-lock');
}));

test('native lock state no longer acts as reactive thread-wide message or reaction deletion', withStore(async (store) => {
  const f = fixture(store);
  await f.run();
  await handleSubareaThreadMessage(f.message(), store);
  await handleSubareaThreadReaction(f.reaction(), f.ordinary.user as User, store);
  assert.equal(f.counters.deletedMessages, 0); assert.equal(f.counters.removedReactions, 0);
}));

test('unlock restores native thread access and retains individual mute records', withStore(async (store) => {
  const f = fixture(store); f.mute(); await f.run();
  f.state.action = 'unlock'; await f.run();
  assert.equal(f.channel.locked, false); assert.equal(f.channel.archived, false);
  assert.equal(store.getSubareaLock(id.guild, f.channel.id), null);
  assert.equal(store.getSubareaRestriction(id.guild, f.channel.id, f.ordinary.id)?.muted, true);
  await handleSubareaThreadMessage(f.message(), store);
  await handleSubareaThreadReaction(f.reaction(), f.ordinary.user as User, store);
  assert.equal(f.counters.deletedMessages, 1); assert.equal(f.counters.removedReactions, 1);
}));

test('an unknown native lock is not reopened by an ordinary creator, but a native administrator can recover it', withStore(async (store) => {
  const f = fixture(store); f.channel.locked = true; f.channel.archived = true; f.state.action = 'unlock';
  await assert.rejects(f.run(), /管理員|來源|紀錄/);
  assert.equal(f.channel.locked, true); assert.equal(f.counters.edits, 0);
  f.state.actorId = id.admin; await f.run();
  assert.equal(f.channel.locked, false); assert.equal(f.channel.archived, false);
  assert.equal(store.listCases(id.guild)[0]?.action, 'subarea-unlock');
}));

test('automatic archival without a native lock does not prevent creator recovery', withStore(async (store) => {
  const f = fixture(store); f.channel.archived = true; f.channel.locked = false; f.state.action = 'unlock';
  assert.equal(store.getSubareaLock(id.guild, f.channel.id), null);
  await f.run();
  assert.equal(f.channel.archived, false); assert.equal(f.channel.locked, false);
  assert.equal(f.counters.edits, 1);
  assert.equal(store.listCases(id.guild)[0]?.action, 'subarea-unlock');
}));

test('thread native edit failure rolls back a new Bot lock and never audits successful locking', withStore(async (store) => {
  const f = fixture(store); f.state.failEdit = true;
  await assert.rejects(f.run(), { code: 50013 });
  assert.equal(store.getSubareaLock(id.guild, f.channel.id), null);
  assert.equal(f.channel.locked, false); assert.equal(f.channel.archived, false);
  assert.deepEqual(store.listCases(id.guild), []);
}));

test('ordinary participants cannot lock or unlock another creator registered area', withStore(async (store) => {
  const f = fixture(store); f.state.actorId = id.member;
  await assert.rejects(f.run(), /建立者|協管|管理員/);
  f.state.action = 'unlock'; await assert.rejects(f.run(), /建立者|協管|管理員/);
  assert.equal(f.counters.edits, 0); assert.deepEqual(store.listCases(id.guild), []);
}));

test('native administrator lock cannot be removed or downgraded by a creator or delegate', withStore(async (store) => {
  const f = fixture(store); f.state.actorId = id.admin; await f.run();
  const original = store.getSubareaLock(id.guild, f.channel.id)!;
  assert.equal(original.source, 'admin');
  store.setSubareaDelegate(id.guild, f.channel.id, id.member, id.owner);
  for (const userId of [id.owner, id.member]) {
    f.state.actorId = userId; f.state.action = 'unlock';
    await assert.rejects(f.run(), /管理員|處分/);
    f.state.action = 'lock'; await assert.rejects(f.run(), /管理員|處分/);
    assert.equal(store.getSubareaLock(id.guild, f.channel.id)?.lockId, original.lockId);
  }
  assert.equal(f.channel.locked, true); assert.equal(f.channel.archived, true);
  f.state.actorId = id.admin; f.state.action = 'unlock'; await f.run();
  assert.equal(f.channel.locked, false); assert.equal(store.getSubareaLock(id.guild, f.channel.id), null);
}));

test('an administrator who is also the creator still creates an administrative lock', withStore(async (store) => {
  const f = fixture(store); f.owner.permissions.add(P.Administrator); await f.run();
  assert.equal(store.getSubareaLock(id.guild, f.channel.id)?.source, 'admin');
  f.owner.permissions.remove(P.Administrator); f.state.action = 'unlock';
  await assert.rejects(f.run(), /管理員|處分/);
  assert.equal(f.channel.archived, true);
}));

test('admin promotion retains the original lock snapshot and invalidates its previous recovery generation', withStore(async (store) => {
  const f = fixture(store); await f.run(); const before = store.getSubareaLock(id.guild, f.channel.id)!;
  f.state.actorId = id.admin; await f.run(); const after = store.getSubareaLock(id.guild, f.channel.id)!;
  assert.equal(after.source, 'admin'); assert.equal(after.lockedBy, id.admin);
  assert.equal(after.overwrites, before.overwrites); assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.originalArchived, before.originalArchived); assert.equal(after.originalLocked, before.originalLocked);
  assert.notEqual(after.lockId, before.lockId);
  f.state.actorId = id.owner;
  await assert.rejects(f.recover(before.lockId), /失效|管理員|處分|變更/);
  assert.equal(f.channel.archived, true);
}));

test('repeating the same creator lock is idempotent and preserves its original recovery generation', withStore(async (store) => {
  const f = fixture(store); await f.run(); const before = store.getSubareaLock(id.guild, f.channel.id)!;
  const cases = store.listCases(id.guild).length;
  await f.run();
  assert.equal(store.getSubareaLock(id.guild, f.channel.id)?.lockId, before.lockId);
  assert.equal(f.counters.edits, 1); assert.equal(store.listCases(id.guild).length, cases);
}));

test('a stale recovery generation cannot unlock a later new lock', withStore(async (store) => {
  const f = fixture(store); await f.run(); const old = store.getSubareaLock(id.guild, f.channel.id)!.lockId;
  f.state.action = 'unlock'; await f.run(); f.state.action = 'lock'; await f.run();
  const current = store.getSubareaLock(id.guild, f.channel.id)!;
  assert.notEqual(current.lockId, old);
  await assert.rejects(f.recover(old), /失效|變更/);
  assert.equal(f.channel.archived, true); assert.equal(store.getSubareaLock(id.guild, f.channel.id)?.lockId, current.lockId);
}));

test('revoking a delegate during fresh channel lookup prevents native unlock', withStore(async (store) => {
  const f = fixture(store); await f.run(); store.setSubareaDelegate(id.guild, f.channel.id, id.member, id.owner);
  f.state.actorId = id.member; f.state.action = 'unlock';
  f.state.onChannelFetch = () => { store.deleteSubareaDelegate(id.guild, f.channel.id, id.member); };
  await assert.rejects(f.run(), /建立者|協管|權限已變更/);
  assert.equal(f.channel.archived, true); assert.equal(f.counters.edits, 1);
}));

test('revoking a delegate while a pre-lock notice is sent prevents the subsequent native lock', withStore(async (store) => {
  const f = fixture(store); store.setSubareaDelegate(id.guild, f.channel.id, id.member, id.owner);
  f.state.actorId = id.member;
  f.state.onNotice = () => { store.deleteSubareaDelegate(id.guild, f.channel.id, id.member); };
  await assert.rejects(f.run(), /建立者|協管|權限已變更/);
  assert.equal(f.channel.locked, false); assert.equal(f.channel.archived, false);
  assert.equal(f.counters.edits, 0); assert.deepEqual(store.listCases(id.guild), []);
}));

test('notification transport failures leave the native lock and successful member record intact', withStore(async (store) => {
  const f = fixture(store); f.state.failNotice = true; f.state.failDm = true;
  await f.run();
  assert.equal(f.channel.locked, true); assert.equal(f.channel.archived, true);
  assert.equal(store.listCases(id.guild)[0]?.action, 'subarea-lock');
  assert.ok(store.getSubareaLock(id.guild, f.channel.id));
  assert.match(f.replies.at(-1)?.content ?? '', /鎖定/);
  assert.match(f.replies.at(-1)?.content ?? '', /通知|私訊/);
}));

test('lock notice never reopens a thread after successful native archiving', withStore(async (store) => {
  const f = fixture(store); await f.run();
  const lockedAt = f.transport.indexOf('lock'); assert.ok(lockedAt >= 0);
  assert.equal(f.transport.slice(lockedAt + 1).includes('unlock'), false);
  assert.equal(f.transport.slice(lockedAt + 1).includes('notice'), false);
  assert.equal(f.channel.archived, true);
}));

test('native lock state and its authority survive database restart and reconciliation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-thread-lock-'));
  const path = join(directory, 'bot.sqlite'); let store = new Store(path);
  try {
    const first = fixture(store); await first.run(); const before = store.getSubareaLock(id.guild, first.channel.id)!;
    store.close(); store = new Store(path); const restarted = fixture(store, first.channel.id);
    await reconcileSubareaLocks(restarted.client, store);
    assert.equal(restarted.channel.locked, true); assert.equal(restarted.channel.archived, true);
    assert.equal(store.getSubareaLock(id.guild, first.channel.id)?.lockId, before.lockId);
    assert.equal(store.getSubareaLock(id.guild, first.channel.id)?.source, 'owner');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('startup upgrades a legacy soft thread lock to native closure without assuming its authority', withStore(async (store) => {
  const f = fixture(store); store.setSubareaLock(id.guild, f.channel.id, '[]', id.owner);
  await reconcileSubareaLocks(f.client, store);
  assert.equal(f.channel.archived, true); assert.equal(f.channel.locked, true);
  const migrated = store.getSubareaLock(id.guild, f.channel.id)!;
  assert.equal(migrated.mode, 'thread-native'); assert.equal(migrated.source, 'legacy');
  f.state.action = 'unlock'; await assert.rejects(f.run(), /管理員|來源|舊版/);
}));

test('startup preserves an already native-closed legacy thread instead of reopening it', withStore(async (store) => {
  const f = fixture(store); store.setSubareaLock(id.guild, f.channel.id, '[]', id.owner);
  f.channel.archived = true; f.channel.locked = true;
  await reconcileSubareaLocks(f.client, store);
  assert.equal(f.channel.archived, true); assert.equal(f.channel.locked, true);
  assert.equal(f.transport.includes('unlock'), false);
}));

test('startup does not reclose an area whose queued lock snapshot was removed before queue admission', withStore(async (store) => {
  const f = fixture(store);
  store.setSubareaLock(id.guild, f.channel.id, '[]', id.owner, { mode: 'thread-native', source: 'owner' });
  let release!: () => void;
  let entered!: () => void;
  const admitted = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holding = managedAreaOperation(`${id.guild}:${f.channel.id}`, async () => { entered(); await gate; });
  await admitted;
  const reconciling = reconcileSubareaLocks(f.client, store);
  store.deleteSubareaLock(id.guild, f.channel.id);
  release();
  await Promise.all([holding, reconciling]);
  assert.equal(f.counters.edits, 0);
  assert.equal(f.channel.locked, false); assert.equal(f.channel.archived, false);
  assert.equal(store.getSubareaLock(id.guild, f.channel.id), null);
}));

test('startup does not apply or convert a lock removed during a Discord channel fetch', withStore(async (store) => {
  const f = fixture(store); store.setSubareaLock(id.guild, f.channel.id, '[]', id.owner);
  f.state.onChannelFetch = () => { store.deleteSubareaLock(id.guild, f.channel.id); };
  await reconcileSubareaLocks(f.client, store);
  assert.equal(f.counters.edits, 0);
  assert.equal(f.channel.locked, false); assert.equal(f.channel.archived, false);
  assert.equal(store.getSubareaLock(id.guild, f.channel.id), null);
}));

for (const failingCleanup of ['deleteSubareaLock', 'listSubareaRestrictions'] as const) {
  test(`confirmed native unlock still reports success and persists its case when ${failingCleanup} fails`, withStore(async (store) => {
    const f = fixture(store); await f.run(); f.state.action = 'unlock';
    const original = store[failingCleanup];
    store[failingCleanup] = () => { throw new Error('cleanup storage failure'); };
    try { await f.run(); } finally {
      if (failingCleanup === 'deleteSubareaLock') store.deleteSubareaLock = original as Store['deleteSubareaLock'];
      else store.listSubareaRestrictions = original as Store['listSubareaRestrictions'];
    }
    assert.equal(f.channel.locked, false); assert.equal(f.channel.archived, false);
    const content = f.replies.at(-1)?.content ?? '';
    assert.match(content, /已解鎖子區/);
    assert.match(content, /清理失敗/);
    assert.equal(store.listMemberCases(id.guild, id.owner)[0]?.action, 'subarea-unlock');
    assert.equal(store.listMemberCases(id.guild, id.owner)[0]?.channelId, f.channel.id);
  }));
}
