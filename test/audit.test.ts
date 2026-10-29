import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, type ChatInputCommandInteraction, type EmbedBuilder } from 'discord.js';
import { record } from '../src/audit.js';
import { Store } from '../src/store.js';

const ids = {
  guildA: '510000000000000001', guildB: '510000000000000002',
  actor: '510000000000000003', target: '510000000000000004',
  channelA: '510000000000000005', channelB: '510000000000000006',
};
type LogPayload = { embeds: EmbedBuilder[]; allowedMentions: { parse: string[] } };

function fixture(guildId: string, channelId: string) {
  const fetched: string[] = [];
  const sent: LogPayload[] = [];
  const channel = {
    id: channelId, guildId, type: ChannelType.GuildText,
    async send(payload: LogPayload) { sent.push(payload); },
  };
  const state = { failFetch: false, failSend: false, onFetch: () => {} };
  const command = {
    guildId, channelId, user: { id: ids.actor },
    guild: { id: guildId, channels: { async fetch(id: string) {
      fetched.push(id);
      state.onFetch();
      if (state.failFetch) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
      if (state.failSend) return { ...channel, async send() { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } };
      return channel;
    } } },
  } as unknown as ChatInputCommandInteraction<'cached'>;
  return { command, channel, state, fetched, sent };
}

async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  const store = new Store(':memory:');
  try { await run(store); } finally { store.close(); }
}

test('audit replies use guild-local case numbers even when internal IDs are shared', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    const b = fixture(ids.guildB, ids.channelB);
    assert.equal(await record(a.command, store, 'warn', ids.target, 'A warning'), '\n本服案件 #1');
    assert.equal(await record(a.command, store, 'timeout', ids.target, 'A timeout'), '\n本服案件 #2');
    assert.equal(await record(b.command, store, 'warn', ids.target, 'B warning'), '\n本服案件 #1');
    assert.equal(store.listCases(ids.guildB)[0]?.id, 3);
    assert.equal(store.listCases(ids.guildB)[0]?.caseNumber, 1);
    assert.deepEqual(b.fetched, []);
    assert.deepEqual(b.sent, []);
  });
});

test('disabled log channel never fetches or sends while retaining appealable local cases', async () => {
  await withStore(async (store) => {
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    const b = fixture(ids.guildB, ids.channelB);
    b.state.failFetch = true;
    const result = await record(b.command, store, 'ban', ids.target, 'B-only private reason');
    assert.equal(result, '\n本服案件 #1');
    assert.deepEqual(b.fetched, []);
    assert.deepEqual(b.sent, []);
    assert.equal(store.listCases(ids.guildB)[0]?.reason, 'B-only private reason');
    assert.deepEqual(store.listCases(ids.guildA), []);
  });
});

test('configured logs publish only to the invoking guild and display its local case number', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    const b = fixture(ids.guildB, ids.channelB);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    store.updateSettings(ids.guildB, { logChannelId: ids.channelB });
    await record(a.command, store, 'timeout', ids.target, 'A timeout');
    await record(b.command, store, 'warn', ids.target, 'B operation @everyone');
    assert.deepEqual(a.fetched, [ids.channelA]);
    assert.deepEqual(b.fetched, [ids.channelB]);
    assert.equal(a.sent.length, 1);
    assert.equal(b.sent.length, 1);
    assert.equal(b.sent[0]?.embeds[0]?.toJSON().title, '本服案件 #1 · 警告');
    assert.deepEqual(b.sent[0]?.allowedMentions, { parse: [] });
    assert.equal(store.listCases(ids.guildB)[0]?.caseNumber, 1);
  });
});

test('outside recovery with local notices disabled still records the selected target privately', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    const targetChannelId = '510000000000000007';
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA, subareaNoticesEnabled: false });
    const result = await record(a.command, store, 'subarea-unlock', null, '解除子區鎖定', `子區 ${targetChannelId}`, targetChannelId);
    assert.equal(result, '\n成員紀錄 #1');
    assert.deepEqual(a.fetched, []);
    assert.deepEqual(a.sent, []);
    assert.equal(store.listCases(ids.guildA)[0]?.channelId, targetChannelId);
    assert.equal(store.listCases(ids.guildA)[0]?.details, `子區 ${targetChannelId}`);
  });
});

test('a foreign-guild channel is rejected before any management content is sent', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    a.channel.guildId = ids.guildB;
    const result = await record(a.command, store, 'warn', ids.target, 'Private guild A content');
    assert.deepEqual(a.sent, []);
    assert.match(result, /本服案件 #1/);
    assert.match(result, /紀錄頻道發送失敗/);
    assert.equal(store.listCases(ids.guildA)[0]?.reason, 'Private guild A content');
    assert.deepEqual(store.listCases(ids.guildB), []);
  });
});

test('unsupported log channels do not receive content or discard the stored case', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    a.channel.type = ChannelType.GuildVoice;
    const result = await record(a.command, store, 'warn', ids.target, 'Keep local');
    assert.equal(a.sent.length, 0);
    assert.match(result, /本服案件 #1/);
    assert.equal(store.listCases(ids.guildA).length, 1);
  });
});

test('log delivery failure reports the correct local case and preserves history', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    const b = fixture(ids.guildB, ids.channelB);
    await record(a.command, store, 'timeout', ids.target, 'Other guild');
    store.updateSettings(ids.guildB, { logChannelId: ids.channelB });
    b.state.failSend = true;
    const result = await record(b.command, store, 'warn', ids.target, 'Local reason');
    assert.match(result, /^\n本服案件 #1\n/);
    assert.match(result, /已保存在本機/);
    assert.equal(store.listCases(ids.guildB)[0]?.id, 2);
    assert.equal(store.listCases(ids.guildB)[0]?.caseNumber, 1);
  });
});

test('local database failure never attempts an external management log', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    store.addCase = () => { throw new Error('Storage unavailable'); };
    const result = await record(a.command, store, 'warn', ids.target, 'Cannot persist');
    assert.match(result, /本機管理紀錄寫入失敗/);
    assert.deepEqual(a.fetched, []);
    assert.deepEqual(a.sent, []);
  });
});

test('disabling the guild log while its channel is being fetched cancels the notification', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    a.state.onFetch = () => { store.updateSettings(ids.guildA, { logChannelId: null }); };
    const result = await record(a.command, store, 'warn', ids.target, 'Keep local only');
    assert.equal(result, '\n本服案件 #1');
    assert.deepEqual(a.sent, []);
    assert.equal(store.listCases(ids.guildA)[0]?.reason, 'Keep local only');
  });
});

test('every subarea operation with local notices disabled stays private without a server-log fallback', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA, subareaNoticesEnabled: false });
    a.state.failFetch = true;
    const actions = ['subarea-create', 'subarea-assign', 'subarea-mute', 'subarea-unmute', 'subarea-kick',
      'subarea-unkick', 'subarea-pin', 'subarea-unpin', 'subarea-delete-message', 'subarea-slowmode',
      'subarea-rename', 'subarea-lock', 'subarea-unlock', 'subarea-delete', 'subarea-delegate',
      'subarea-undelegate', 'subarea-tag', 'subarea-role-tag', 'subarea-announce'];
    for (const [index, action] of actions.entries()) {
      const result = await record(a.command, store, action, ids.target, 'Private local action', 'Local details');
      assert.equal(result, `\n成員紀錄 #${index + 1}`);
      const entry = store.listCases(ids.guildA)[0]!;
      assert.equal(entry.scope, 'member');
      assert.equal(entry.moderatorId, ids.actor);
      assert.equal(entry.userId, ids.target);
      assert.equal(entry.reason, 'Private local action');
      assert.equal(entry.details, 'Local details');
      assert.equal(entry.channelId, ids.channelA);
    }
    assert.deepEqual(a.fetched, []);
    assert.deepEqual(a.sent, []);
  });
});

test('APP actions and administrative housekeeping bypass server-log settings entirely', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    store.getSettings = () => { throw new Error('Member activity must not read server-log settings'); };
    const actions = ['message-pin', 'message-unpin', 'message-delete', 'clear', 'config', 'role-add', 'role-remove',
      'channel-edit', 'access-grant', 'access-revoke', 'appeal-submit', 'appeal-review', 'future-local-action'];
    for (const [index, action] of actions.entries()) {
      const result = await record(a.command, store, action, null, 'Member operation');
      assert.equal(result, `\n成員紀錄 #${index + 1}`);
      assert.doesNotMatch(result, /失敗/);
    }
    assert.deepEqual(a.fetched, []);
    assert.deepEqual(a.sent, []);
    assert.equal(store.listCases(ids.guildA).length, 10);
  });
});

test('server sanctions and their reversals continue notifying the configured guild log', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    const actions = ['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'warning-remove'];
    for (const [index, action] of actions.entries()) {
      assert.equal(await record(a.command, store, action, ids.target, 'Server sanction'), `\n本服案件 #${index + 1}`);
      assert.equal(store.listCases(ids.guildA)[0]?.scope, 'server');
    }
    assert.equal(a.fetched.length, actions.length);
    assert.equal(a.sent.length, actions.length);
    assert.ok(a.sent.every((payload) => payload.allowedMentions.parse.length === 0));
  });
});

test('a failed member-ledger write reports the storage failure without falling back to server logs', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    store.addCase = () => { throw new Error('Member storage unavailable'); };
    const result = await record(a.command, store, 'subarea-kick', ids.target, 'Local restriction');
    assert.match(result, /本機管理紀錄寫入失敗/);
    assert.doesNotMatch(result, /成員紀錄 #|本服案件 #/);
    assert.deepEqual(a.fetched, []);
    assert.deepEqual(a.sent, []);
  });
});

test('server-log action filters retain all cases while publishing only selected management actions', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    store.setNotificationActions(ids.guildA, 'management', ['timeout']);
    await record(a.command, store, 'warn', ids.target, 'Unselected but retained');
    assert.deepEqual(a.fetched, []);
    await record(a.command, store, 'timeout', ids.target, 'Selected management action');
    assert.equal(a.sent.length, 1);
    assert.match(a.sent[0]!.embeds[0]!.toJSON().title ?? '', /禁言/);
    assert.equal(store.listServerCases(ids.guildA).length, 2);
    assert.equal(store.getGuildCase(ids.guildA, 1)?.reason, 'Unselected but retained');
  });
});

test('a management action disabled while fetching a server-log channel is not posted', async () => {
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    a.state.onFetch = () => { store.setNotificationActions(ids.guildA, 'management', []); };
    assert.equal(await record(a.command, store, 'warn', ids.target, 'Pending log'), '\n本服案件 #1');
    assert.deepEqual(a.fetched, [ids.channelA]);
    assert.deepEqual(a.sent, []);
    assert.equal(store.listServerCases(ids.guildA).length, 1);
  });
});

test('an unreadable management filter stops server-log delivery after retaining the completed case', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withStore(async (store) => {
    const a = fixture(ids.guildA, ids.channelA);
    store.updateSettings(ids.guildA, { logChannelId: ids.channelA });
    store.isNotificationActionEnabled = () => { throw new Error('Unreadable action settings'); };
    const result = await record(a.command, store, 'ban', ids.target, 'Completed sanction');
    assert.match(result, /本服案件 #1/);
    assert.match(result, /紀錄頻道發送失敗/);
    assert.deepEqual(a.fetched, []);
    assert.deepEqual(a.sent, []);
    assert.equal(store.getGuildCase(ids.guildA, 1)?.action, 'ban');
  });
});
