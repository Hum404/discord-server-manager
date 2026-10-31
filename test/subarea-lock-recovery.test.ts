import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ChannelType, MessageFlags, PermissionFlagsBits as P, PermissionsBitField,
  type Guild, type Interaction,
} from 'discord.js';
import { Store, type SubareaLock } from '../src/store.js';
import { handleSubareaLockRecovery, notifySubareaLockOwner } from '../src/subarea-lock-recovery.js';
import { handleInteraction } from '../src/bot.js';

const ids = { guild: '860000000000000001', otherGuild: '860000000000000002', channel: '860000000000000003',
  owner: '860000000000000004', other: '860000000000000005', bot: '860000000000000006',
  admin: '860000000000000007', message: '860000000000000008' };
type Payload = { content?: string; components?: unknown[]; flags?: MessageFlags };

function savedLock(store: Store, source: SubareaLock['source'] = 'owner'): SubareaLock {
  store.setSubarea(ids.guild, ids.channel, ids.owner);
  return store.setSubareaLock(ids.guild, ids.channel, '[]', source === 'admin' ? ids.admin : ids.owner,
    { mode: 'thread-native', source, originalLocked: false, originalArchived: false });
}

function fixture(store: Store, lock = savedLock(store)) {
  const state = { failDm: false, failEdit: false, failReplyOnce: false,
    actorId: ids.owner as string, guildId: null as string | null,
    onOwnerFetch: () => {}, onGuildFetch: () => {}, ownerVisible: true, privateMember: true };
  const calls: string[] = [];
  const replies: Payload[] = [];
  const dms: Payload[] = [];
  const sent: Payload[] = [];
  const memberPermissions = new PermissionsBitField(P.ViewChannel | P.ReadMessageHistory
    | P.SendMessages | P.SendMessagesInThreads | P.UseApplicationCommands);
  const owner = { id: ids.owner, guild: undefined as unknown, user: { id: ids.owner, bot: false },
    permissions: memberPermissions,
    async send(payload: Payload) {
      calls.push('dm');
      if (state.failDm) throw { code: 50007 };
      dms.push(payload);
    } };
  const bot = { id: ids.bot, guild: undefined as unknown, user: { id: ids.bot, bot: true },
    permissions: new PermissionsBitField(PermissionsBitField.All) };
  const channel = { id: ids.channel, guildId: ids.guild, guild: undefined as unknown,
    type: ChannelType.PublicThread as ChannelType, name: 'test', locked: true, archived: true,
    permissionsFor(member: { id: string; permissions: PermissionsBitField }) {
      return member.id === ids.owner && !state.ownerVisible ? new PermissionsBitField() : member.permissions;
    },
    members: { async fetch() {
      if (!state.privateMember) throw { code: 50001 };
      return { id: ids.owner };
    } },
    async edit(options: { locked: boolean; archived: boolean }) {
      calls.push('edit');
      if (state.failEdit) throw { code: 50013 };
      Object.assign(channel, options);
      return channel;
    },
    async send(payload: Payload) { calls.push('notice'); sent.push(payload); return { id: ids.message }; },
  };
  const guild = { id: ids.guild, ownerId: ids.admin,
    roles: { async fetch() { calls.push('roles'); } },
    members: {
      async fetch(options: { user: string; force: boolean }) {
        assert.equal(options.force, true);
        assert.equal(options.user, ids.owner);
        calls.push('member'); state.onOwnerFetch(); return owner;
      },
      async fetchMe() { calls.push('bot'); return bot; },
    },
    channels: { async fetch(id: string) { assert.equal(id, ids.channel); calls.push('channel'); return channel; } },
  };
  owner.guild = guild; bot.guild = guild; channel.guild = guild;
  const client = { guilds: { async fetch(id: string) {
    assert.equal(id, ids.guild); calls.push('guild'); state.onGuildFetch(); return guild;
  } } };
  const interaction = {
    get user() { return { id: state.actorId }; },
    get guildId() { return state.guildId; }, channelId: '860000000000000009',
    customId: `subarea-unlock:${ids.guild}:${ids.channel}:${lock.lockId}:${ids.owner}`,
    client, deferred: false, replied: false,
    isButton: () => true, isChatInputCommand: () => false,
    isMessageContextMenuCommand: () => false, isRepliable: () => true,
    inGuild: () => state.guildId !== null,
    async deferReply(payload: Payload = {}) { calls.push('defer'); interaction.deferred = true; replies.push(payload); },
    async reply(payload: Payload) { interaction.replied = true; replies.push(payload); },
    async editReply(payload: Payload) {
      if (state.failReplyOnce) { state.failReplyOnce = false; throw { code: 10062 }; }
      replies.push(payload);
    },
  };
  return { state, calls, replies, dms, sent, owner, channel, lock, interaction,
    guild: guild as unknown as Guild,
    run: () => handleSubareaLockRecovery(interaction as unknown as Interaction, store) };
}

function withStore(run: (store: Store) => Promise<void>) {
  return async () => { const store = new Store(':memory:'); try { await run(store); } finally { store.close(); } };
}
function text(payloads: Payload[]): string { return payloads.map((payload) => payload.content ?? '').join('\n'); }
function renderedButtons(payload: Payload | undefined): Array<{ custom_id: string }> {
  const json = JSON.parse(JSON.stringify(payload)) as { components?: Array<{ components?: Array<{ custom_id: string }> }> };
  return json.components?.flatMap((row) => row.components ?? []) ?? [];
}

test('lock recovery DM binds the owner and durable lock generation and contains an outside command', withStore(async (store) => {
  const f = fixture(store);
  assert.equal(await notifySubareaLockOwner(f.guild, store, f.lock, ids.owner), '');
  assert.equal(f.dms.length, 1);
  const button = renderedButtons(f.dms[0])[0];
  assert.equal(button?.custom_id, f.interaction.customId);
  assert.ok(button!.custom_id.length <= 100);
  assert.match(text(f.dms), /鎖定並封存/);
  assert.match(text(f.dms), new RegExp(`/子區 解鎖 頻道編號:${ids.channel}`));
}));

test('admin and unknown legacy locks notify the owner without offering a self-unlock button', withStore(async (store) => {
  for (const source of ['admin', 'legacy'] as const) {
    store.deleteSubareaLock(ids.guild, ids.channel);
    const f = fixture(store, savedLock(store, source));
    assert.equal(await notifySubareaLockOwner(f.guild, store, f.lock, ids.owner), '');
    assert.deepEqual(renderedButtons(f.dms[0]), []);
    assert.match(text(f.dms), /只有原生伺服器管理員可以解除/);
  }
}));

test('lock DM delivery failure is reported separately without changing the successful lock', withStore(async (store) => {
  const f = fixture(store); f.state.failDm = true;
  const warning = await notifySubareaLockOwner(f.guild, store, f.lock, ids.owner);
  assert.match(warning, /鎖定已完成.*私訊通知發送失敗/);
  assert.equal(store.getSubareaLock(ids.guild, ids.channel)?.lockId, f.lock.lockId);
  assert.equal(f.channel.locked, true);
  assert.equal(f.channel.archived, true);
  assert.ok(!f.calls.includes('edit'));
}));

test('lock DM honors the child notice switch and per-action filter', withStore(async (store) => {
  const f = fixture(store);
  store.updateSettings(ids.guild, { subareaNoticesEnabled: false });
  assert.equal(await notifySubareaLockOwner(f.guild, store, f.lock, ids.owner), '');
  store.updateSettings(ids.guild, { subareaNoticesEnabled: true });
  store.setNotificationActions(ids.guild, 'subarea', []);
  assert.equal(await notifySubareaLockOwner(f.guild, store, f.lock, ids.owner), '');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.dms, []);
}));

test('notice state and ownership are rechecked after the owner lookup', withStore(async (store) => {
  const f = fixture(store);
  f.state.onOwnerFetch = () => store.updateSettings(ids.guild, { subareaNoticesEnabled: false });
  assert.equal(await notifySubareaLockOwner(f.guild, store, f.lock, ids.owner), '');
  assert.deepEqual(f.dms, []);
  store.updateSettings(ids.guild, { subareaNoticesEnabled: true });
  f.state.onOwnerFetch = () => store.setSubarea(ids.guild, ids.channel, ids.other);
  assert.equal(await notifySubareaLockOwner(f.guild, store, f.lock, ids.owner), '');
  assert.deepEqual(f.dms, []);
}));

test('an owner can use the persistent DM button and ACK precedes all guild permission lookups', withStore(async (store) => {
  const f = fixture(store);
  assert.equal(await f.run(), true);
  assert.equal(f.calls[0], 'defer');
  assert.ok(f.calls.indexOf('guild') > f.calls.indexOf('defer'));
  assert.equal(f.replies[0]?.flags, undefined, 'DM response does not request a guild-only ephemeral reply');
  assert.equal(f.channel.locked, false);
  assert.equal(f.channel.archived, false);
  assert.equal(store.getSubareaLock(ids.guild, ids.channel), null);
  assert.match(text(f.replies), /已解鎖/);
  assert.equal(store.listCases(ids.guild)[0]?.action, 'subarea-unlock');
  assert.equal(store.listCases(ids.guild)[0]?.channelId, ids.channel);
}));

test('the root interaction router dispatches a persistent DM unlock and records the bound child area', withStore(async (store) => {
  const f = fixture(store);
  await handleInteraction(f.interaction as unknown as Interaction, store);
  assert.equal(f.calls[0], 'defer');
  assert.equal(f.calls.filter((call) => call === 'defer').length, 1);
  assert.ok(f.calls.indexOf('guild') > f.calls.indexOf('defer'));
  assert.equal(f.replies[0]?.flags, undefined);
  assert.equal(f.channel.locked, false);
  assert.equal(f.channel.archived, false);
  assert.equal(store.getSubareaLock(ids.guild, ids.channel), null);
  assert.match(text(f.replies), /已解鎖/);
  const cases = store.listCases(ids.guild);
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.action, 'subarea-unlock');
  assert.equal(cases[0]?.scope, 'member');
  assert.equal(cases[0]?.guildId, ids.guild);
  assert.equal(cases[0]?.channelId, ids.channel);
  assert.equal(cases[0]?.moderatorId, ids.owner);
}));

test('forwarded buttons and wrong-guild invocation cannot unlock or fetch the bound guild', withStore(async (store) => {
  for (const wrong of ['actor', 'guild']) {
    const f = fixture(store);
    if (wrong === 'actor') f.state.actorId = ids.other;
    else f.state.guildId = ids.otherGuild;
    assert.equal(await f.run(), true);
    assert.deepEqual(f.calls, ['defer']);
    assert.ok(store.getSubareaLock(ids.guild, ids.channel));
    assert.match(text(f.replies), /失效|建立者/);
    if (wrong === 'guild') assert.equal(f.replies[0]?.flags, MessageFlags.Ephemeral);
  }
}));

test('old buttons cannot unlock a replacement lock, even when the creator is unchanged', withStore(async (store) => {
  const f = fixture(store);
  store.deleteSubareaLock(ids.guild, ids.channel);
  const replacement = savedLock(store);
  assert.notEqual(replacement.lockId, f.lock.lockId);
  await f.run();
  assert.deepEqual(f.calls, ['defer']);
  assert.equal(store.getSubareaLock(ids.guild, ids.channel)?.lockId, replacement.lockId);
}));

test('revoked ownership and administrative lock promotion invalidate old recovery controls', withStore(async (store) => {
  const f = fixture(store);
  store.setSubarea(ids.guild, ids.channel, ids.other);
  await f.run();
  assert.deepEqual(f.calls, ['defer']);
  store.setSubarea(ids.guild, ids.channel, ids.owner);
  store.updateSubareaLockMetadata(ids.guild, ids.channel, { source: 'admin', lockedBy: ids.admin });
  const promoted = fixture(store, store.getSubareaLock(ids.guild, ids.channel)!);
  await promoted.run();
  assert.deepEqual(promoted.calls, ['defer']);
  assert.match(text(promoted.replies), /管理員/);
  assert.equal(store.getSubareaLock(ids.guild, ids.channel)?.source, 'admin');
}));

test('ownership changes while fetching the guild cannot race the button into an unlock', withStore(async (store) => {
  const f = fixture(store);
  f.state.onGuildFetch = () => store.setSubarea(ids.guild, ids.channel, ids.other);
  await f.run();
  assert.deepEqual(f.calls, ['defer', 'guild']);
  assert.equal(f.channel.locked, true);
  assert.ok(store.getSubareaLock(ids.guild, ids.channel));
}));

test('button unlock still checks current channel visibility and private thread membership', withStore(async (store) => {
  const f = fixture(store); f.state.ownerVisible = false;
  await f.run();
  assert.ok(!f.calls.includes('edit'));
  assert.match(text(f.replies), /查看|讀取/);
  f.state.ownerVisible = true; f.channel.type = ChannelType.PrivateThread; f.state.privateMember = false;
  await f.run();
  assert.ok(!f.calls.includes('edit'));
  assert.match(text(f.replies), /私密|成員/);
  assert.ok(store.getSubareaLock(ids.guild, ids.channel));
}));

test('a failed native unlock retains the lock and does not claim success', withStore(async (store) => {
  const f = fixture(store); f.state.failEdit = true;
  await f.run();
  assert.match(text(f.replies), /未能完成/);
  assert.doesNotMatch(text(f.replies), /已解鎖/);
  assert.ok(store.getSubareaLock(ids.guild, ids.channel));
  assert.deepEqual(store.listCases(ids.guild), []);
}));

test('a reply transport failure after a successful unlock does not turn the result into a failure', withStore(async (store) => {
  const f = fixture(store); f.state.failReplyOnce = true;
  await f.run();
  assert.equal(store.getSubareaLock(ids.guild, ids.channel), null);
  assert.match(text(f.replies), /已解鎖/);
  assert.doesNotMatch(text(f.replies), /操作未能完成/);
}));

test('malformed recovery IDs are acknowledged safely while unrelated buttons are ignored', withStore(async (store) => {
  const f = fixture(store);
  f.interaction.customId = 'subarea-unlock:broken';
  assert.equal(await f.run(), true);
  assert.deepEqual(f.calls, ['defer']);
  f.calls.length = 0;
  f.interaction.customId = 'appeal:open:elsewhere';
  assert.equal(await f.run(), false);
  assert.deepEqual(f.calls, []);
}));

test('a recovery button remains usable after reopening the database without a collector', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'subarea-lock-dm-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  try {
    const original = savedLock(store);
    const f = fixture(store, original);
    const customId = f.interaction.customId;
    store.close(); store = new Store(path);
    const restarted = fixture(store, store.getSubareaLock(ids.guild, ids.channel)!);
    assert.equal(restarted.interaction.customId, customId);
    await restarted.run();
    assert.match(text(restarted.replies), /已解鎖/);
    assert.equal(store.getSubareaLock(ids.guild, ids.channel), null);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
