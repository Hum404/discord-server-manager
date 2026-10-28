import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits as P, PermissionsBitField, type ChatInputCommandInteraction } from 'discord.js';
import { handleRecordsCommand } from '../src/records.js';
import { Store } from '../src/store.js';

const id = {
  guild: '850000000000000001', actor: '850000000000000002', target: '850000000000000003',
  staff: '850000000000000004', channel: '850000000000000005', otherGuild: '850000000000000006',
  owner: '850000000000000007', other: '850000000000000008',
};

function fixture() {
  const state = {
    userId: null as string | null, direction: null as string | null, recordId: null as number | null,
    onRoles: () => {}, onMember: () => {},
  };
  const actor = { id: id.actor, permissions: new PermissionsBitField() };
  const replies: Array<{ embeds: Array<{ toJSON(): { title?: string; description?: string; fields?: Array<{ name: string; value: string }>; footer?: { text: string } } }>; files?: unknown[]; allowedMentions: unknown }> = [];
  const fetched: string[] = [];
  const guild = {
    id: id.guild, ownerId: id.owner,
    roles: { async fetch() { state.onRoles(); } },
    members: { async fetch(options: { user: string; force: boolean }) {
      assert.equal(options.force, true); fetched.push(options.user); state.onMember();
      assert.equal(options.user, actor.id, 'historical subjects do not need to remain in the guild');
      return actor;
    } },
  };
  const command = {
    guildId: id.guild, guild, user: { id: id.actor },
    options: {
      getUser: () => state.userId === null ? null : { id: state.userId },
      getString: () => state.direction,
      getInteger: () => state.recordId,
    },
    async editReply(payload: typeof replies[number]) { replies.push(payload); },
  } as unknown as ChatInputCommandInteraction<'cached'>;
  return { command, state, actor, guild, replies, fetched,
    output: () => JSON.stringify(replies.map((reply) => reply.embeds.map((embed) => embed.toJSON()))),
  };
}

function memberRecord(store: Store, input: Partial<Parameters<Store['addCase']>[0]> = {}) {
  return store.addCase({ guildId: id.guild, action: 'subarea-mute', userId: id.target,
    moderatorId: id.actor, reason: '只在此子區處理', channelId: id.channel, ...input });
}

function withStore(run: (store: Store) => Promise<void>) {
  return async () => { const store = new Store(':memory:'); try { await run(store); } finally { store.close(); } };
}

test('a member can read their performed operations without native management rights', withStore(async (store) => {
  const own = memberRecord(store);
  memberRecord(store, { moderatorId: id.staff, reason: '他人操作不應出現' });
  memberRecord(store, { action: 'warn', reason: '全服處罰不屬於成員紀錄' });
  memberRecord(store, { guildId: id.otherGuild, reason: '別服內容不應出現' });
  const f = fixture();
  await handleRecordsCommand(f.command, store);
  assert.match(f.output(), new RegExp(`紀錄 #${own.caseNumber}`));
  assert.match(f.output(), /子區禁言/);
  assert.match(f.output(), new RegExp(id.channel));
  assert.doesNotMatch(f.output(), /他人操作不應出現|全服處罰不屬於成員紀錄|別服內容不應出現/);
  assert.deepEqual(f.replies[0]?.allowedMentions, { parse: [] });
  assert.deepEqual(f.fetched, [id.actor]);
}));

test('received and all directions include only the selected member relationship', withStore(async (store) => {
  memberRecord(store, { moderatorId: id.staff, userId: id.actor, reason: '收到的處理' });
  memberRecord(store, { reason: '執行的處理' });
  memberRecord(store, { moderatorId: id.staff, userId: id.target, reason: '無關處理' });
  const f = fixture(); f.state.direction = 'received';
  await handleRecordsCommand(f.command, store);
  assert.match(f.output(), /收到的處理/); assert.doesNotMatch(f.output(), /執行的處理|無關處理/);
  f.state.direction = 'all';
  await handleRecordsCommand(f.command, store);
  const last = JSON.stringify(f.replies.at(-1)?.embeds[0]?.toJSON());
  assert.match(last, /收到的處理/); assert.match(last, /執行的處理/); assert.doesNotMatch(last, /無關處理/);
}));

test('ordinary users cannot inspect another member records through Bot grants or local ownership', withStore(async (store) => {
  store.setGrant(id.guild, id.actor, 'clear', id.staff);
  store.setSubarea(id.guild, id.channel, id.actor);
  store.setSubareaDelegate(id.guild, id.channel, id.target, id.actor);
  memberRecord(store, { moderatorId: id.target });
  const f = fixture(); f.state.userId = id.target;
  await assert.rejects(handleRecordsCommand(f.command, store), /只能查看自己的成員紀錄/);
  assert.equal(f.replies.length, 0);
}));

test('native managers can inspect a historical member without fetching that subject', withStore(async (store) => {
  memberRecord(store, { moderatorId: id.target, reason: '已離開成員的歷史操作' });
  const f = fixture(); f.state.userId = id.target; f.actor.permissions.add(P.ManageGuild);
  await handleRecordsCommand(f.command, store);
  assert.match(f.output(), /已離開成員的歷史操作/);
  assert.deepEqual(f.fetched, [id.actor]);
}));

test('guild owners and native administrators can inspect other member records', withStore(async (store) => {
  memberRecord(store, { moderatorId: id.target });
  for (const owner of [true, false]) {
    const f = fixture(); f.state.userId = id.target;
    if (owner) f.guild.ownerId = id.actor;
    else f.actor.permissions.add(P.Administrator);
    await handleRecordsCommand(f.command, store);
    assert.match(f.output(), /子區禁言/);
  }
}));

test('native rights revoked while roles refresh or actor fetch runs prevent other-member reads', withStore(async (store) => {
  memberRecord(store, { moderatorId: id.target });
  for (const stage of ['roles', 'member']) {
    const f = fixture(); f.state.userId = id.target; f.actor.permissions.add(P.ManageGuild);
    const revoke = () => { f.actor.permissions.remove(P.ManageGuild); };
    if (stage === 'roles') f.state.onRoles = revoke;
    else f.state.onMember = revoke;
    await assert.rejects(handleRecordsCommand(f.command, store), /原生管理伺服器權限/);
    assert.equal(f.replies.length, 0);
  }
}));

test('a record ID must match this guild, member, direction and member scope', withStore(async (store) => {
  const performed = memberRecord(store);
  const received = memberRecord(store, { moderatorId: id.staff, userId: id.actor });
  const unrelated = memberRecord(store, { moderatorId: id.staff, userId: id.target });
  const server = memberRecord(store, { action: 'timeout' });
  const foreign = memberRecord(store, { guildId: id.otherGuild });
  const f = fixture();
  for (const recordId of [received.caseNumber, unrelated.caseNumber, server.caseNumber, 999]) {
    f.state.recordId = recordId;
    await assert.rejects(handleRecordsCommand(f.command, store), /找不到符合此成員/);
  }
  // The same local number in another guild must never select its record.
  f.state.recordId = foreign.caseNumber;
  await handleRecordsCommand(f.command, store);
  assert.match(f.output(), new RegExp(`成員操作紀錄 #${performed.caseNumber}`));
  assert.equal(f.replies.length, 1);
  f.state.recordId = received.caseNumber; f.state.direction = 'received';
  await handleRecordsCommand(f.command, store);
  assert.equal(f.replies.length, 2);
}));

test('full member records retain immutable history after their source subarea is deleted', withStore(async (store) => {
  store.setSubarea(id.guild, id.channel, id.actor);
  const original = memberRecord(store, { action: 'subarea-delete', userId: null,
    details: '來源子區的刪除已完成', reason: '建立者確認刪除 @everyone' });
  store.deleteSubarea(id.guild, id.channel);
  const f = fixture(); f.state.recordId = original.caseNumber;
  await handleRecordsCommand(f.command, store);
  assert.match(f.output(), /來源子區的刪除已完成/);
  assert.match(f.output(), /@everyone/);
  assert.match(f.output(), new RegExp(id.channel));
  assert.deepEqual(f.replies[0]?.allowedMentions, { parse: [] });
}));

test('markdown is escaped and oversized complete text stays in a private response attachment', withStore(async (store) => {
  const details = '**完整內容** @everyone\n'.repeat(100);
  const original = memberRecord(store, { reason: '**需要處理** @everyone', details });
  const f = fixture(); f.state.recordId = original.caseNumber;
  await handleRecordsCommand(f.command, store);
  const embed = f.replies[0]?.embeds[0]?.toJSON();
  assert.match(embed?.fields?.find((field) => field.name === '原因')?.value ?? '', /\\\*/);
  assert.match(embed?.footer?.text ?? '', /私人附件/);
  const attachment = f.replies[0]?.files?.[0] as { attachment: Buffer; name: string };
  assert.ok(Buffer.isBuffer(attachment.attachment));
  assert.ok(attachment.attachment.toString('utf8').includes(details));
  assert.equal(attachment.name, `member-record-${original.caseNumber}.txt`);
  assert.deepEqual(f.replies[0]?.allowedMentions, { parse: [] });
}));

test('record query rejects invalid direction or IDs and renders an empty member ledger', withStore(async (store) => {
  const f = fixture();
  f.state.direction = 'unknown';
  await assert.rejects(handleRecordsCommand(f.command, store), /請選擇執行的操作/);
  f.state.direction = null;
  for (const invalid of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    f.state.recordId = invalid;
    await assert.rejects(handleRecordsCommand(f.command, store), /有效的本服成員紀錄編號/);
  }
  f.state.recordId = null;
  await handleRecordsCommand(f.command, store);
  assert.match(f.output(), /沒有符合條件/);
}));
