import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, PermissionsBitField, PermissionFlagsBits,
  type ChatInputCommandInteraction, type Message, type MessageReaction, type User } from 'discord.js';
import { Store } from '../src/store.js';
import { createThreadSubarea, ensureThreadArea, handleThreadSubarea,
  handleSubareaThreadMessage, handleSubareaThreadReaction } from '../src/subarea-threads.js';

const ids = {
  guild: '330000000000000001', actor: '330000000000000002', bot: '330000000000000003',
  target: '330000000000000004', other: '330000000000000005', category: '330000000000000006',
  parent: '330000000000000007', forum: '330000000000000008', created: '330000000000000009',
  role: '330000000000000010', interaction: '330000000000000011',
};
let sequence = 100;
const base = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads];
type FakeMember = {
  id: string; permissions: PermissionsBitField; user: { id: string; bot: boolean }; guild: unknown;
  send(payload: unknown): Promise<void>;
};

function fixture(store: Store, action = 'mute', registered = true) {
  const channelId = String(330000000000001000n + BigInt(sequence++));
  const counters = { deleted: 0, removed: 0, added: 0, created: 0, sent: 0, dm: 0, reactions: 0, deletedThread: 0 };
  const replies: Array<{ content?: string }> = [];
  const sent: unknown[] = [];
  const state = {
    action, type: 'thread', selectedId: channelId, parentId: ids.parent as string,
    reason: '違反本帖規則', message: '通知 @everyone', name: '新子區', content: '第一則訊息',
    confirmation: 'yes', onDM: () => {}, onConfirmation: () => {}, onMemberFetch: (_id: string) => {},
    privateMembers: new Set<string>([ids.actor, ids.target]),
    failRemove: false, failDM: false,
  };
  const members = new Map<string, FakeMember>();
  function member(id: string, bot: boolean) {
    const result: FakeMember = { id, user: { id, bot }, guild: undefined,
      permissions: new PermissionsBitField(base),
      async send() {
        counters.dm++;
        state.onDM();
        if (state.failDM) throw Object.assign(new Error('closed DM'), { code: 50007 });
      } };
    members.set(id, result);
    return result;
  }
  const actor = member(ids.actor, false);
  const target = member(ids.target, false);
  const other = member(ids.other, false);
  const bot = member(ids.bot, true);
  bot.permissions.add([PermissionFlagsBits.ManageThreads, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.MentionEveryone]);
  function thread(id: string, type = ChannelType.PublicThread) {
    return {
      id, type, guildId: ids.guild, guild: undefined as unknown, ownerId: ids.actor as string,
      locked: false, archived: false,
      parentId: ids.parent, parent: undefined as unknown,
      permissionsFor(subject: FakeMember) { return subject.permissions; },
      members: {
        async fetch(options: { member: string; force: boolean; cache: boolean }) {
          assert.equal(options.force, true);
          assert.equal(options.cache, false);
          if (!state.privateMembers.has(options.member)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
          return { id: options.member };
        },
        async remove(userId: string) {
          assert.equal(userId, ids.target);
          if (state.failRemove) throw Object.assign(new Error('refused'), { code: 50013 });
          counters.removed++;
        },
        async add(_userId: string) { counters.added++; },
      },
      async send(payload: unknown) { sent.push(payload); counters.sent++; },
      async delete() { counters.deletedThread++; },
    };
  }
  const current = thread(channelId);
  const created = thread(ids.created);
  created.ownerId = ids.bot;
  const parent = {
    id: ids.parent, guildId: ids.guild, type: ChannelType.GuildText,
    parentId: ids.category,
    permissionsFor(subject: FakeMember) { return subject.permissions; },
    threads: { async create(_payload: unknown) { counters.created++; return created; } },
  };
  const forum = { ...parent, id: ids.forum, type: ChannelType.GuildForum };
  const channels = new Map<string, unknown>([[current.id, current], [parent.id, parent], [forum.id, forum], [created.id, created]]);
  const guild = {
    id: ids.guild, ownerId: ids.other, name: '測試社群',
    roles: { async fetch(id?: string) { return id ? { id } : undefined; } },
    members: {
      async fetch(options: { user: string; force: boolean }) {
        assert.equal(options.force, true);
        state.onMemberFetch(options.user);
        const found = members.get(options.user);
        if (!found) throw Object.assign(new Error('missing member'), { code: 10007 });
        return found;
      },
      async fetchMe() { return bot; },
    },
    channels: { async fetch(id: string) { return channels.get(id) ?? null; } },
  };
  current.guild = guild;
  created.guild = guild;
  for (const value of members.values()) value.guild = guild;
  const command = {
    id: ids.interaction, guild, guildId: ids.guild, channelId, user: { id: ids.actor },
    options: {
      getSubcommand() { return state.action; },
      getUser() { return target.user; },
      getRole() { return { id: ids.role }; },
      getString(name: string) { return (state as unknown as Record<string, string>)[name] ?? null; },
      getChannel(name: string) { return channels.get(name === 'parent' ? state.parentId : state.selectedId) ?? null; },
    },
    async editReply(payload: { content?: string }) {
      replies.push(payload);
      return {
        async awaitMessageComponent(options: { filter(value: { user: { id: string }; customId: string }): boolean }) {
          if (state.confirmation === 'timeout') throw { code: 'InteractionCollectorError' };
          const customId = `thread:${state.confirmation === 'yes' ? 'remove' : 'cancel'}:${ids.interaction}`;
          assert.equal(options.filter({ user: { id: ids.target }, customId }), false);
          assert.equal(options.filter({ user: { id: ids.actor }, customId }), true);
          return { customId, async update(value: { content?: string }) { replies.push(value); state.onConfirmation(); } };
        },
      };
    },
  } as unknown as ChatInputCommandInteraction<'cached'>;
  if (registered) store.setSubarea(ids.guild, current.id, actor.id);
  const message = {
    id: '330000000000002001', guild, channel: current, author: target.user,
    async delete() { counters.deleted++; },
  } as unknown as Message;
  const reaction = { message, users: { async remove(userId: string) { assert.equal(userId, ids.target); counters.reactions++; } } } as unknown as MessageReaction;
  return { command, current, parent, forum, created, actor, target, other, bot, guild, members, channels,
    counters, state, replies, sent, message, reaction,
    reply: () => replies.at(-1)?.content ?? '',
    restrict() { return store.setSubareaRestriction({ guildId: ids.guild, channelId: current.id, userId: target.id,
      muted: true, kicked: false, originalAllow: null, originalDeny: null, moderatorId: actor.id, reason: '測試禁言' }); },
  };
}

async function withStore(run: (store: Store) => Promise<void>) {
  const store = new Store(':memory:');
  try { await run(store); } finally { store.close(); }
}

test('thread discovery adopts an existing human post without changing established ownership or delegates', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'info', false);
    await ensureThreadArea(f.command, store);
    assert.equal(store.getSubarea(ids.guild, f.current.id)?.ownerId, ids.actor);
    store.setSubarea(ids.guild, f.current.id, ids.target);
    store.setSubareaDelegate(ids.guild, f.current.id, ids.other, ids.target);
    await ensureThreadArea(f.command, store);
    assert.equal(store.getSubarea(ids.guild, f.current.id)?.ownerId, ids.target);
    assert.ok(store.getSubareaDelegate(ids.guild, f.current.id, ids.other));
  });
});

test('thread discovery does not assign Bot-owned posts or absent native owners to arbitrary command users', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'info', false);
    f.current.ownerId = ids.bot;
    await ensureThreadArea(f.command, store);
    assert.equal(store.getSubarea(ids.guild, f.current.id), null);
    f.current.ownerId = '330000000000009999';
    await ensureThreadArea(f.command, store);
    assert.equal(store.getSubarea(ids.guild, f.current.id), null);
  });
});

test('thread mute persists a local restriction and deletes new messages without server-wide sanctions', async () => {
  await withStore(async (store) => {
    const f = fixture(store);
    assert.equal(await handleThreadSubarea(f.command, store), true);
    assert.equal(store.getSubareaRestriction(ids.guild, f.current.id, ids.target)?.muted, true);
    await handleSubareaThreadMessage(f.message, store);
    assert.equal(f.counters.deleted, 1);
    assert.equal(f.counters.removed, 0);
    assert.match(f.reply(), /不影響其他頻道/);
    assert.equal(store.listCases(ids.guild)[0]?.action, 'subarea-mute');
    assert.equal(store.listCases(ids.guild)[0]?.userId, ids.target);
  });
});

test('thread restriction applies only in its registered guild and thread; unrelated messages stay', async () => {
  await withStore(async (store) => {
    const f = fixture(store);
    f.restrict();
    const second = fixture(store);
    await handleSubareaThreadMessage(second.message, store);
    assert.equal(second.counters.deleted, 0);
    await handleSubareaThreadMessage({ ...f.message, channel: { ...f.current, guildId: '330000000000009888' } } as unknown as Message, store);
    assert.equal(f.counters.deleted, 0);
  });
});

test('thread reaction removal enforces persistent mute and stops immediately after unmute', async () => {
  await withStore(async (store) => {
    const f = fixture(store);
    f.restrict();
    await handleSubareaThreadReaction(f.reaction, f.target.user as unknown as User, store);
    assert.equal(f.counters.reactions, 1);
    f.state.action = 'unmute';
    await handleThreadSubarea(f.command, store);
    await handleSubareaThreadMessage(f.message, store);
    await handleSubareaThreadReaction(f.reaction, f.target.user as unknown as User, store);
    assert.equal(f.counters.deleted, 0);
    assert.equal(f.counters.reactions, 1);
    assert.equal(store.getSubareaRestriction(ids.guild, f.current.id, ids.target), null);
  });
});

test('thread moderation allows local delegates and rejects unrelated members', async () => {
  await withStore(async (store) => {
    const f = fixture(store);
    store.setSubarea(ids.guild, f.current.id, ids.other);
    await assert.rejects(handleThreadSubarea(f.command, store), /建立者、協管/);
    store.setSubareaDelegate(ids.guild, f.current.id, ids.actor, ids.other);
    await handleThreadSubarea(f.command, store);
    assert.equal(store.getSubareaRestriction(ids.guild, f.current.id, ids.target)?.muted, true);
  });
});

test('revoking a delegate while punishment DM is delivered prevents queued restriction', async () => {
  await withStore(async (store) => {
    const f = fixture(store);
    store.setSubarea(ids.guild, f.current.id, ids.other);
    store.setSubareaDelegate(ids.guild, f.current.id, ids.actor, ids.other);
    f.state.onDM = () => { store.deleteSubareaDelegate(ids.guild, f.current.id, ids.actor); };
    await assert.rejects(handleThreadSubarea(f.command, store), /建立者、協管/);
    assert.equal(store.getSubareaRestriction(ids.guild, f.current.id, ids.target), null);
    assert.equal(store.listCases(ids.guild).length, 0);
  });
});

test('thread moderation protects native staff and the current creator', async () => {
  await withStore(async (store) => {
    const f = fixture(store);
    f.target.permissions.add(PermissionFlagsBits.ManageGuild);
    await assert.rejects(handleThreadSubarea(f.command, store), /不能限制/);
    assert.equal(f.counters.dm, 0);
  });
});

test('native staff and current creator are exempt from stale reactive mute rows', async () => {
  await withStore(async (store) => {
    const f = fixture(store);
    f.restrict();
    f.target.permissions.add(PermissionFlagsBits.Administrator);
    await handleSubareaThreadMessage(f.message, store);
    assert.equal(f.counters.deleted, 0);
    f.target.permissions.remove(PermissionFlagsBits.Administrator);
    store.setSubarea(ids.guild, f.current.id, ids.target);
    await handleSubareaThreadMessage(f.message, store);
    assert.equal(f.counters.deleted, 0);
  });
});

test('mute revoked during reactive author refresh does not delete the message', async () => {
  await withStore(async (store) => {
    const f = fixture(store);
    f.restrict();
    f.state.onMemberFetch = (userId) => { if (userId === ids.target) store.deleteSubareaRestriction(ids.guild, f.current.id, ids.target); };
    await handleSubareaThreadMessage(f.message, store);
    assert.equal(f.counters.deleted, 0);
  });
});

test('thread kick confirms, removes membership only and explains public rejoining', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'kick');
    await handleThreadSubarea(f.command, store);
    assert.equal(f.counters.removed, 1);
    assert.match(f.reply(), /公開討論串仍可查看或重新加入/);
    assert.equal(store.getSubareaRestriction(ids.guild, f.current.id, ids.target), null);
    f.state.action = 'unkick';
    await handleThreadSubarea(f.command, store);
    assert.equal(f.counters.added, 1);
  });
});

test('thread kick cancellation and expired confirmation leave membership unchanged', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'kick');
    f.state.confirmation = 'no';
    await handleThreadSubarea(f.command, store);
    assert.equal(f.counters.removed, 0);
    assert.equal(f.counters.dm, 0);
    f.state.confirmation = 'timeout';
    await handleThreadSubarea(f.command, store);
    assert.equal(f.counters.removed, 0);
    assert.match(f.reply(), /逾時/);
  });
});

test('creator transfer during thread kick confirmation prevents membership mutation', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'kick');
    f.state.onConfirmation = () => { store.setSubarea(ids.guild, f.current.id, ids.other); };
    await assert.rejects(handleThreadSubarea(f.command, store), /建立者、協管/);
    assert.equal(f.counters.removed, 0);
  });
});

test('thread API removal failure is not recorded as success or lasting access prohibition', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'kick');
    f.state.failRemove = true;
    await assert.rejects(handleThreadSubarea(f.command, store), /refused/);
    assert.equal(store.listCases(ids.guild).length, 0);
    assert.equal(store.getSubareaRestriction(ids.guild, f.current.id, ids.target), null);
  });
});

test('thread notices allow only the creator, with exact mentioned users and roles', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'tag');
    await handleThreadSubarea(f.command, store);
    assert.deepEqual((f.sent[0] as { allowedMentions: unknown }).allowedMentions, { parse: [], users: [ids.target] });
    const second = fixture(store, 'role-tag');
    store.setSubarea(ids.guild, second.current.id, ids.other);
    second.actor.permissions.add(PermissionFlagsBits.Administrator);
    await assert.rejects(handleThreadSubarea(second.command, store), /只有目前子區建立者/);
    assert.equal(second.counters.sent, 0);
  });
});

test('creator transfer during thread tag member lookup blocks the outgoing notification', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'tag');
    f.state.onMemberFetch = (userId) => { if (userId === ids.target) store.setSubarea(ids.guild, f.current.id, ids.other); };
    await assert.rejects(handleThreadSubarea(f.command, store), /只有目前子區建立者/);
    assert.equal(f.counters.sent, 0);
  });
});

test('a creator cannot use local Bot management to bypass an administrative thread lock', async () => {
  await withStore(async (store) => {
    for (const action of ['tag', 'role-tag', 'announce', 'mute']) {
      const f = fixture(store, action);
      store.setSubareaLock(ids.guild, f.current.id, '[]', ids.other,
        { mode: 'thread-native', source: 'admin' });
      f.current.locked = true; f.current.archived = true;
      await assert.rejects(handleThreadSubarea(f.command, store), /管理員鎖定|管理員解除/);
      assert.equal(f.counters.sent, 0);
      assert.equal(f.counters.removed, 0);
      assert.deepEqual(store.listCases(ids.guild), []);
      assert.ok(store.getSubareaLock(ids.guild, f.current.id));
    }
  });
});

test('mention commands cannot implicitly reopen a closed thread even for an administrator creator', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'tag');
    f.actor.permissions.add(PermissionFlagsBits.Administrator);
    f.current.archived = true; f.current.locked = true;
    await assert.rejects(handleThreadSubarea(f.command, store), /先明確解鎖/);
    assert.equal(f.counters.sent, 0);
    assert.equal(f.current.archived, true);
    assert.equal(f.current.locked, true);
    assert.deepEqual(store.listCases(ids.guild), []);
  });
});

test('native closure during mention target lookup prevents the pending Bot post', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'tag');
    f.state.onMemberFetch = (userId) => { if (userId === ids.target) f.current.archived = true; };
    await assert.rejects(handleThreadSubarea(f.command, store), /先明確解鎖/);
    assert.equal(f.counters.sent, 0);
    assert.deepEqual(store.listCases(ids.guild), []);
  });
});

test('admin can register a thread native creator but cannot replace a human post creator', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'assign');
    f.actor.permissions.add(PermissionFlagsBits.Administrator);
    await assert.rejects(handleThreadSubarea(f.command, store), /只能登記原帖主/);
    f.current.ownerId = ids.bot;
    await handleThreadSubarea(f.command, store);
    assert.equal(store.getSubarea(ids.guild, f.current.id)?.ownerId, ids.target);
  });
});

test('thread creation is gated to configured category and saves the invoking human owner', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'create', false);
    await assert.rejects(createThreadSubarea(f.command, store), /尚未開放/);
    assert.equal(f.counters.created, 0);
    store.updateSettings(ids.guild, { subareaCategoryId: ids.category });
    await createThreadSubarea(f.command, store);
    assert.equal(f.counters.created, 1);
    assert.equal(store.getSubarea(ids.guild, ids.created)?.ownerId, ids.actor);
    assert.equal(f.counters.added, 1);
    assert.equal(f.counters.sent, 1);
  });
});

test('forum creation accepts the configured forum without requiring a configured category', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'create', false);
    f.state.type = 'forum';
    f.state.parentId = ids.forum;
    store.updateSettings(ids.guild, { subareaForumId: ids.forum });
    await createThreadSubarea(f.command, store);
    assert.equal(f.counters.created, 1);
    assert.equal(f.counters.sent, 0); // First post content is sent by forum.create, not duplicated.
    assert.match(f.reply(), /論壇帖子/);
  });
});

test('thread creation rechecks disabled configuration after pruning existing areas', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'create');
    store.updateSettings(ids.guild, { subareaCategoryId: ids.category });
    let calls = 0;
    const original = f.guild.channels.fetch;
    f.guild.channels.fetch = async (id: string) => {
      calls++;
      if (calls === 2) store.updateSettings(ids.guild, { subareaCategoryId: null });
      return original(id);
    };
    await assert.rejects(createThreadSubarea(f.command, store), /設定已變更/);
    assert.equal(f.counters.created, 0);
  });
});

test('thread creation enforces caller native creation permission and shared three-area limit', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'create', false);
    store.updateSettings(ids.guild, { subareaCategoryId: ids.category });
    f.actor.permissions.remove(PermissionFlagsBits.CreatePublicThreads);
    await assert.rejects(createThreadSubarea(f.command, store), /缺少/);
    f.actor.permissions.add(PermissionFlagsBits.CreatePublicThreads);
    for (const id of [f.current.id, ids.parent, ids.forum]) store.setSubarea(ids.guild, id, ids.actor);
    await assert.rejects(createThreadSubarea(f.command, store), /最多.*3/);
    assert.equal(f.counters.created, 0);
  });
});

test('private-thread access must still exist after a punishment notice', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'mute');
    f.current.type = ChannelType.PrivateThread;
    f.state.onDM = () => { f.state.privateMembers.delete(ids.actor); };
    await assert.rejects(handleThreadSubarea(f.command, store), /私密討論串/);
    assert.equal(store.getSubareaRestriction(ids.guild, f.current.id, ids.target), null);
    assert.equal(f.counters.removed, 0);
  });
});

test('a private-thread kick cannot execute after the actor is removed during confirmation', async () => {
  await withStore(async (store) => {
    const f = fixture(store, 'kick');
    f.current.type = ChannelType.PrivateThread;
    f.state.onConfirmation = () => { f.state.privateMembers.delete(ids.actor); };
    await assert.rejects(handleThreadSubarea(f.command, store), /私密討論串/);
    assert.equal(f.counters.removed, 0);
    assert.deepEqual(store.listCases(ids.guild), []);
  });
});
