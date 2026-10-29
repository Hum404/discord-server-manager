import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChannelType, PermissionFlagsBits, PermissionsBitField,
  type ChatInputCommandInteraction, type EmbedBuilder, type Guild,
} from 'discord.js';
import { record } from '../src/audit.js';
import { punishmentNoticeTarget } from '../src/punishment-notices.js';
import { Store } from '../src/store.js';

const ids = {
  guild: '710000000000000001', otherGuild: '710000000000000002', actor: '710000000000000003',
  target: '710000000000000004', bot: '710000000000000005', source: '710000000000000006',
  notice: '710000000000000007', log: '710000000000000008', owner: '710000000000000009',
};
type Payload = {
  embeds: EmbedBuilder[]; components?: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>;
  allowedMentions: { parse: string[] };
};

function fixture() {
  const fetched: Array<{ id: string; force: boolean }> = [];
  const sent: Array<{ channelId: string; payload: Payload }> = [];
  const state = {
    type: ChannelType.GuildText as ChannelType,
    targetGuild: ids.guild,
    archived: false, locked: false, missing: 0n,
    memberMissing: false, sendFailures: 0, sendAttempts: 0,
    onFetch: () => {}, onMembershipFetch: () => {},
    rolesFetches: 0, botFetches: 0, membershipFetches: 0,
  };
  const all = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.EmbedLinks,
  ]).bitfield;
  const guild = {
    id: ids.guild, ownerId: ids.owner,
    roles: { async fetch() { state.rolesFetches += 1; } },
    members: { async fetchMe(options: { force: boolean }) {
      assert.equal(options.force, true);
      state.botFetches += 1;
      return { id: ids.bot };
    } },
    channels: { async fetch(id: string, options?: { force?: boolean }) {
      fetched.push({ id, force: options?.force ?? false });
      state.onFetch();
      return {
        id, guild, guildId: state.targetGuild,
        type: id === ids.log ? ChannelType.GuildText : state.type,
        archived: state.archived, locked: state.locked,
        permissionsFor() { return new PermissionsBitField(all & ~state.missing); },
        members: { async fetch() {
          state.membershipFetches += 1;
          state.onMembershipFetch();
          if (state.memberMissing) throw { code: 10007 };
          return { id: ids.bot };
        } },
        async send(payload: Payload) {
          state.sendAttempts += 1;
          if (state.sendFailures-- > 0) throw { code: 50013 };
          sent.push({ channelId: id, payload });
        },
      };
    } },
  };
  const command = {
    guild, guildId: ids.guild, channelId: ids.source, user: { id: ids.actor },
  } as unknown as ChatInputCommandInteraction<'cached'>;
  return { command, guild: guild as unknown as Guild, state, fetched, sent };
}

async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  const store = new Store(':memory:');
  try { await run(store); } finally { store.close(); }
}

function enable(store: Store, patch = {}) {
  store.updateSettings(ids.guild, { punishmentChannelId: ids.notice, punishmentNoticesEnabled: true, ...patch });
}

test('punishment announcements are off by default and unrelated member operations never read settings', async () => {
  await withStore(async (store) => {
    const f = fixture();
    await record(f.command, store, 'ban', ids.target, 'No public destination');
    assert.deepEqual(f.fetched, []);
    enable(store);
    store.getSettings = () => { throw new Error('Unrelated actions must stay private'); };
    for (const action of ['config', 'clear', 'subarea-pin', 'subarea-lock', 'message-delete', 'role-add', 'future-action']) {
      assert.doesNotMatch(await record(f.command, store, action, ids.target, 'Private'), /失敗/);
    }
    assert.deepEqual(f.sent, []);
  });
});

test('completed server punishment notices carry local case, target, actor, duration and exact appeal entry', async () => {
  await withStore(async (store) => {
    const f = fixture();
    store.addCase({ guildId: ids.otherGuild, action: 'warn', userId: ids.target, moderatorId: ids.actor, reason: 'Other guild' });
    enable(store);
    assert.equal(await record(f.command, store, 'timeout', ids.target, '**理由** @everyone', '45 分鐘'), '\n本服案件 #1');
    assert.deepEqual(f.fetched, [{ id: ids.notice, force: true }]);
    assert.equal(f.state.botFetches, 1);
    assert.equal(f.state.rolesFetches, 1);
    const payload = f.sent[0]!.payload;
    const embed = payload.embeds[0]!.toJSON();
    assert.equal(embed.title, '處罰通知 · 伺服器禁言');
    assert.equal(embed.fields?.find((field) => field.name === '案件編號')?.value, '#1');
    assert.equal(embed.fields?.find((field) => field.name === '成員')?.value, `<@${ids.target}>（${ids.target}）`);
    assert.equal(embed.fields?.find((field) => field.name === '執行者')?.value, `<@${ids.actor}>（${ids.actor}）`);
    assert.equal(embed.fields?.find((field) => field.name === '禁言時長')?.value, '45 分鐘');
    assert.match(embed.fields?.find((field) => field.name === '原因')?.value ?? '', /\\\*\\\*理由/);
    assert.ok(embed.timestamp);
    assert.equal(payload.components?.[0]?.toJSON().components[0]?.custom_id, `appeal:case:${ids.guild}:1:${ids.target}`);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
  });
});

test('all server sanctions and reversals notify while reversals omit the appeal button', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store);
    const actions = ['warn', 'timeout', 'kick', 'ban', 'untimeout', 'unban', 'warning-remove'];
    for (const action of actions) await record(f.command, store, action, ids.target, 'Reason');
    assert.equal(f.sent.length, actions.length);
    for (const notice of f.sent.slice(4)) {
      assert.match(notice.payload.embeds[0]!.toJSON().title ?? '', /^處罰解除通知/);
      assert.deepEqual(notice.payload.components, []);
      assert.equal(notice.payload.embeds[0]!.toJSON().color, 0x23a55a);
    }
  });
});

test('local punishments require explicit opt-in and remain member records even with server logging configured', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { logChannelId: ids.log });
    assert.equal(await record(f.command, store, 'subarea-mute', ids.target, 'Local'), '\n成員紀錄 #1');
    assert.deepEqual(f.fetched, []);
    store.updateSettings(ids.guild, { punishmentIncludeSubareas: true });
    for (const action of ['subarea-mute', 'subarea-unmute', 'subarea-kick', 'subarea-unkick']) {
      await record(f.command, store, action, ids.target, 'Local', 'Local details', ids.source);
    }
    assert.equal(f.sent.length, 4);
    assert.ok(f.sent.every((notice) => notice.channelId === ids.notice));
    assert.equal(store.listServerCases(ids.guild).length, 0);
    assert.equal(store.listMemberCases(ids.guild, ids.actor).length, 5);
    const fields = f.sent[0]!.payload.embeds[0]!.toJSON().fields;
    assert.equal(fields?.find((field) => field.name === '影響範圍')?.value, '僅指定子區');
    assert.equal(fields?.find((field) => field.name === '處罰子區')?.value, `<#${ids.source}>`);
  });
});

test('server log and punishment notice destinations are independent and identical destinations send once', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { logChannelId: ids.log });
    await record(f.command, store, 'warn', ids.target, 'Independent destinations');
    assert.deepEqual(f.sent.map((notice) => notice.channelId), [ids.notice, ids.log]);
    store.updateSettings(ids.guild, { logChannelId: ids.notice });
    await record(f.command, store, 'ban', ids.target, 'Same destination');
    assert.equal(f.sent.length, 3);
    assert.equal(f.sent[2]?.payload.embeds[0]?.toJSON().title, '處罰通知 · 封鎖');
  });
});

test('failed announcement still permits the same-channel server log and preserves the saved case', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { logChannelId: ids.notice });
    f.state.sendFailures = 1;
    const result = await record(f.command, store, 'ban', ids.target, 'Saved');
    assert.match(result, /本服案件 #1/);
    assert.match(result, /處罰通知發送失敗/);
    assert.equal(f.state.sendAttempts, 2);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.payload.embeds[0]!.toJSON().title, '本服案件 #1 · 封鎖');
    assert.equal(store.getGuildCase(ids.guild, 1)?.reason, 'Saved');
  });
});

test('a failed server log cannot prevent a successfully delivered separate announcement', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { logChannelId: ids.log });
    f.state.onFetch = () => { if (f.fetched.at(-1)?.id === ids.log) f.state.sendFailures = 1; };
    const result = await record(f.command, store, 'kick', ids.target, 'Saved');
    assert.match(result, /紀錄頻道發送失敗/);
    assert.doesNotMatch(result, /處罰通知發送失敗/);
    assert.equal(f.sent[0]?.channelId, ids.notice);
    assert.equal(store.listCases(ids.guild).length, 1);
  });
});

test('disabled or retargeted settings during fresh channel lookup cancel pending announcements', async () => {
  await withStore(async (store) => {
    const f = fixture();
    for (const patch of [{ punishmentNoticesEnabled: false }, { punishmentChannelId: ids.log }]) {
      enable(store);
      f.state.onFetch = () => { store.updateSettings(ids.guild, patch); };
      assert.doesNotMatch(await record(f.command, store, 'warn', ids.target, 'Cancel pending'), /失敗/);
    }
    assert.deepEqual(f.sent, []);
  });
});

test('removing the local-punishment scope during lookup cancels a local notice without changing its record', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { punishmentIncludeSubareas: true });
    f.state.onFetch = () => { store.updateSettings(ids.guild, { punishmentIncludeSubareas: false }); };
    assert.equal(await record(f.command, store, 'subarea-kick', ids.target, 'Scope changed'), '\n成員紀錄 #1');
    assert.deepEqual(f.sent, []);
    assert.equal(store.listMemberCases(ids.guild, ids.actor).length, 1);
  });
});

test('cross-guild notification destinations are rejected without sending or falling back publicly', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store);
    f.state.targetGuild = ids.otherGuild;
    assert.match(await record(f.command, store, 'warn', ids.target, 'Guild-private reason'), /處罰通知發送失敗/);
    assert.deepEqual(f.sent, []);
    assert.equal(store.listCases(ids.guild).length, 1);
    assert.equal(store.listCases(ids.otherGuild).length, 0);
  });
});

test('actual thread and forum-post destinations use thread-send permission, not parent send permission', async () => {
  for (const type of [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]) {
    const f = fixture();
    f.state.type = type;
    f.state.missing = PermissionFlagsBits.SendMessages;
    const target = await punishmentNoticeTarget(f.guild, ids.notice);
    assert.equal(target.type, type);
    assert.equal(f.state.membershipFetches, type === ChannelType.PrivateThread ? 1 : 0);
    f.state.missing |= PermissionFlagsBits.SendMessagesInThreads;
    await assert.rejects(punishmentNoticeTarget(f.guild, ids.notice), /在討論串傳送訊息/);
  }
});

test('forum containers, categories, voice destinations and foreign guilds cannot receive notices', async () => {
  const f = fixture();
  for (const type of [ChannelType.GuildForum, ChannelType.GuildCategory, ChannelType.GuildVoice]) {
    f.state.type = type;
    await assert.rejects(punishmentNoticeTarget(f.guild, ids.notice), /實際的討論串／論壇帖子/);
  }
  f.state.type = ChannelType.GuildText;
  f.state.targetGuild = ids.otherGuild;
  await assert.rejects(punishmentNoticeTarget(f.guild, ids.notice), /本伺服器/);
  assert.deepEqual(f.sent, []);
});

test('archived or locked threads are rejected and never reopened', async () => {
  const f = fixture();
  f.state.type = ChannelType.PublicThread;
  f.state.archived = true;
  await assert.rejects(punishmentNoticeTarget(f.guild, ids.notice), /封存或鎖定/);
  f.state.archived = false;
  f.state.locked = true;
  await assert.rejects(punishmentNoticeTarget(f.guild, ids.notice), /封存或鎖定/);
  assert.deepEqual(f.sent, []);
});

test('private-thread membership is checked separately from inherited permission bits', async () => {
  const f = fixture();
  f.state.type = ChannelType.PrivateThread;
  f.state.memberMissing = true;
  await assert.rejects(punishmentNoticeTarget(f.guild, ids.notice), /機器人不是這個私密討論串的成員/);
  assert.equal(f.state.membershipFetches, 1);
  assert.deepEqual(f.sent, []);
});

test('private-thread permission revocation during membership lookup is honored', async () => {
  const f = fixture();
  f.state.type = ChannelType.PrivateThread;
  f.state.onMembershipFetch = () => { f.state.missing = PermissionFlagsBits.ViewChannel; };
  await assert.rejects(punishmentNoticeTarget(f.guild, ids.notice), /查看頻道/);
  assert.equal(f.state.membershipFetches, 1);
  assert.deepEqual(f.sent, []);
});

test('missing view, embeds or text-send permission rejects the selected destination', async () => {
  const f = fixture();
  for (const flag of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.SendMessages]) {
    f.state.missing = flag;
    await assert.rejects(punishmentNoticeTarget(f.guild, ids.notice), /機器人缺少以下權限/);
  }
  assert.deepEqual(f.sent, []);
});

test('notification settings from another guild never activate notices in the invoking guild', async () => {
  await withStore(async (store) => {
    const f = fixture();
    store.updateSettings(ids.otherGuild, { punishmentChannelId: ids.notice, punishmentNoticesEnabled: true });
    assert.equal(await record(f.command, store, 'warn', ids.target, 'Isolated'), '\n本服案件 #1');
    assert.deepEqual(f.fetched, []);
    assert.deepEqual(f.sent, []);
  });
});
