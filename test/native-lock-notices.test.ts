import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, PermissionFlagsBits as P, PermissionsBitField, type EmbedBuilder, type Guild } from 'discord.js';
import { record, type AuditContext } from '../src/audit.js';
import { deliverNativeSubareaLockNotice } from '../src/punishment-notices.js';
import { Store } from '../src/store.js';

const ids = { guild: '790000000000000001', otherGuild: '790000000000000002', actor: '790000000000000003',
  channel: '790000000000000004', invoking: '790000000000000005', bot: '790000000000000006',
  global: '790000000000000007', owner: '790000000000000008' };
type Payload = { embeds: EmbedBuilder[]; allowedMentions: { parse: string[] } };

function fixture() {
  const state = { type: ChannelType.PublicThread as ChannelType, archived: false, locked: false,
    channelGuild: ids.guild, missing: 0n, memberMissing: false, sendFails: false,
    onFetch: () => {}, onMembershipFetch: () => {} };
  const fetched: string[] = [];
  const sent: Payload[] = [];
  const counters = { edits: 0, joins: 0, membership: 0, sends: 0 };
  const all = P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.SendMessagesInThreads | P.EmbedLinks;
  const channel = {
    id: ids.channel,
    get guildId() { return state.channelGuild; },
    get type() { return state.type; },
    get archived() { return state.archived; },
    get locked() { return state.locked; },
    permissionsFor() { return new PermissionsBitField(all & ~state.missing); },
    members: { async fetch() {
      counters.membership++;
      state.onMembershipFetch();
      if (state.memberMissing) throw { code: 10007 };
      return { id: ids.bot };
    }, async join() { counters.joins++; } },
    async edit() { counters.edits++; },
    async send(payload: Payload) {
      counters.sends++;
      if (state.sendFails) throw { code: 50013 };
      sent.push(payload);
    },
  };
  const guild = {
    id: ids.guild, ownerId: ids.owner,
    roles: { async fetch() {} },
    members: { async fetchMe() { return { id: ids.bot }; } },
    channels: { async fetch(channelId: string) {
      fetched.push(channelId); state.onFetch(); return channel;
    } },
  } as unknown as Guild;
  Object.assign(channel, { guild });
  const command: AuditContext = { guild, guildId: ids.guild, channelId: ids.invoking, user: { id: ids.actor } };
  return { state, fetched, sent, counters, command };
}

function withStore(run: (store: Store) => Promise<void>) {
  return async () => { const store = new Store(':memory:'); try { await run(store); } finally { store.close(); } };
}

test('native closure notice announces a pending request inside the selected thread without claiming success', withStore(async (store) => {
  const f = fixture();
  store.updateSettings(ids.guild, { logChannelId: ids.global, punishmentChannelId: ids.global, punishmentNoticesEnabled: true });
  assert.deepEqual(await deliverNativeSubareaLockNotice(f.command, store, ids.channel, 'owner'), {
    sentChannelId: ids.channel, warning: '',
  });
  assert.deepEqual(f.fetched, [ids.channel]);
  assert.equal(f.sent.length, 1);
  const embed = f.sent[0]!.embeds[0]!.toJSON();
  assert.equal(embed.title, '子區鎖定申請');
  assert.match(embed.description ?? '', /接下來.*原生鎖定/);
  assert.match(embed.description ?? '', /實際鎖定狀態/);
  assert.doesNotMatch(JSON.stringify(embed), /已完成|已鎖定|成員紀錄編號|案件編號/);
  assert.equal(embed.fields?.find((field) => field.name === '執行者')?.value, `<@${ids.actor}>（${ids.actor}）`);
  assert.match(embed.fields?.find((field) => field.name === '如何解鎖')?.value ?? '', new RegExp(ids.channel));
  assert.deepEqual(f.sent[0]!.allowedMentions, { parse: [] });
  assert.equal(f.counters.edits + f.counters.joins, 0);
  assert.deepEqual(store.listCases(ids.guild), [], 'a request notice is not a completed-operation case');
}));

test('native lock notice respects both child master and per-action settings before any transport', withStore(async (store) => {
  const f = fixture();
  store.updateSettings(ids.guild, { subareaNoticesEnabled: false });
  assert.equal((await deliverNativeSubareaLockNotice(f.command, store, ids.channel, 'owner')).warning, '');
  store.updateSettings(ids.guild, { subareaNoticesEnabled: true });
  store.setNotificationActions(ids.guild, 'subarea', ['subarea-unlock']);
  assert.equal((await deliverNativeSubareaLockNotice(f.command, store, ids.channel, 'owner')).warning, '');
  assert.deepEqual(f.fetched, []);
  assert.deepEqual(f.sent, []);
}));

test('disabling the notice during target lookup cancels only the announcement', withStore(async (store) => {
  const f = fixture();
  f.state.onFetch = () => { store.setNotificationActions(ids.guild, 'subarea', []); };
  assert.equal((await deliverNativeSubareaLockNotice(f.command, store, ids.channel, 'delegate')).warning, '');
  assert.equal(f.sent.length, 0);
  assert.equal(f.counters.edits, 0);
}));

test('native lock notices never reopen closed threads or fall back to a global destination', withStore(async (store) => {
  store.updateSettings(ids.guild, { logChannelId: ids.global, punishmentChannelId: ids.global, punishmentNoticesEnabled: true });
  for (const flags of [{ archived: true, locked: true }, { archived: true, locked: false }, { archived: false, locked: true }]) {
    const f = fixture(); Object.assign(f.state, flags);
    assert.match((await deliverNativeSubareaLockNotice(f.command, store, ids.channel, 'admin')).warning, /通知發送失敗/);
    assert.deepEqual(f.fetched, [ids.channel]);
    assert.deepEqual(f.sent, []);
    assert.equal(f.counters.edits + f.counters.joins, 0);
  }
}));

test('native notice permission, membership and transport failures are warnings without mutations', withStore(async (store) => {
  for (const scenario of ['permissions', 'membership', 'transport']) {
    const f = fixture();
    if (scenario === 'permissions') f.state.missing = P.SendMessagesInThreads;
    if (scenario === 'membership') { f.state.type = ChannelType.PrivateThread; f.state.memberMissing = true; }
    if (scenario === 'transport') f.state.sendFails = true;
    const result = await deliverNativeSubareaLockNotice(f.command, store, ids.channel, 'owner');
    assert.equal(result.sentChannelId, null);
    assert.match(result.warning, /通知發送失敗/);
    assert.equal(f.counters.edits + f.counters.joins, 0);
    assert.deepEqual(f.sent, []);
  }
}));

test('private-thread membership yields recheck child settings before sending', withStore(async (store) => {
  const f = fixture(); f.state.type = ChannelType.PrivateThread;
  f.state.onMembershipFetch = () => { store.updateSettings(ids.guild, { subareaNoticesEnabled: false }); };
  const result = await deliverNativeSubareaLockNotice(f.command, store, ids.channel, 'owner');
  assert.equal(result.warning, '');
  assert.equal(f.counters.membership, 1);
  assert.deepEqual(f.sent, []);
}));

test('native lock announcement refuses foreign destinations and non-thread targets', withStore(async (store) => {
  for (const scenario of ['foreign', 'text']) {
    const f = fixture();
    if (scenario === 'foreign') f.state.channelGuild = ids.otherGuild;
    else f.state.type = ChannelType.GuildText;
    const result = await deliverNativeSubareaLockNotice(f.command, store, ids.channel, 'admin');
    assert.match(result.warning, /通知發送失敗/);
    assert.deepEqual(f.sent, []);
    assert.equal(f.counters.edits, 0);
  }
}));

test('notification filter read failures fail closed without blocking the lock caller', withStore(async (store) => {
  const f = fixture();
  store.isNotificationActionEnabled = () => { throw new Error('Malformed stored selection'); };
  const result = await deliverNativeSubareaLockNotice(f.command, store, ids.channel, 'owner');
  assert.equal(result.filterFailed, true);
  assert.match(result.warning, /設定讀取失敗/);
  assert.deepEqual(f.fetched, []);
  assert.deepEqual(f.sent, []);
}));

test('administrator-source notice directs recovery to server administrators', withStore(async (store) => {
  const f = fixture();
  await deliverNativeSubareaLockNotice(f.command, store, ids.channel, 'admin');
  const fields = f.sent[0]!.embeds[0]!.toJSON().fields;
  assert.equal(fields?.find((field) => field.name === '鎖定來源')?.value, '管理員處分鎖定');
  assert.match(fields?.find((field) => field.name === '如何解鎖')?.value ?? '', /須由伺服器管理員/);
}));

test('confirmed native lock persists its isolated member case without posting after archive', withStore(async (store) => {
  const f = fixture(); f.state.locked = true; f.state.archived = true;
  store.addCase({ guildId: ids.otherGuild, action: 'warn', moderatorId: ids.actor, userId: ids.owner, reason: 'Other guild' });
  store.updateSettings(ids.guild, { logChannelId: ids.global, punishmentChannelId: ids.global, punishmentNoticesEnabled: true });
  const result = await record(f.command, store, 'subarea-lock', null, '已鎖定並封存', 'Confirmed state', ids.channel, { noticeHandled: true });
  assert.equal(result, '\n成員紀錄 #1');
  const entry = store.listMemberCases(ids.guild, ids.actor)[0]!;
  assert.equal(entry.caseNumber, 1);
  assert.equal(entry.channelId, ids.channel);
  assert.equal(entry.action, 'subarea-lock');
  assert.equal(store.listCases(ids.otherGuild).length, 1);
  assert.deepEqual(f.fetched, []);
  assert.deepEqual(f.sent, []);
  assert.equal(f.counters.edits + f.counters.joins, 0);
}));

test('noticeHandled does not suppress unlock announcements or remove their audit records', withStore(async (store) => {
  const f = fixture();
  const result = await record(f.command, store, 'subarea-unlock', null, '已解鎖', undefined, ids.channel, { noticeHandled: true });
  assert.equal(result, '\n成員紀錄 #1');
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.embeds[0]!.toJSON().title ?? '', /解鎖子區/);
  assert.equal(store.listMemberCases(ids.guild, ids.actor).length, 1);
}));
