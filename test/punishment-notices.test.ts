import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChannelType, PermissionFlagsBits, PermissionsBitField,
  type ChatInputCommandInteraction, type EmbedBuilder, type Guild,
} from 'discord.js';
import { record } from '../src/audit.js';
import { deliverPunishmentNotice, punishmentNoticeTarget } from '../src/punishment-notices.js';
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
    for (const action of ['config', 'clear', 'subarea-tag', 'subarea-role-tag', 'subarea-announce',
      'message-delete', 'role-add', 'subarea-future-action', 'future-action']) {
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

test('local punishments notify their own area by default while server announcements remain disabled', async () => {
  await withStore(async (store) => {
    const f = fixture();
    store.updateSettings(ids.guild, { logChannelId: ids.log, punishmentChannelId: ids.notice,
      punishmentNoticesEnabled: false, punishmentIncludeSubareas: false });
    for (const action of ['subarea-mute', 'subarea-unmute', 'subarea-kick', 'subarea-unkick']) {
      await record(f.command, store, action, ids.target, 'Local', 'Local details', ids.source);
    }
    assert.equal(f.sent.length, 4);
    assert.ok(f.sent.every((notice) => notice.channelId === ids.source));
    assert.ok(f.fetched.every((fetch) => fetch.id === ids.source));
    assert.equal(store.listServerCases(ids.guild).length, 0);
    assert.equal(store.listMemberCases(ids.guild, ids.actor).length, 4);
    const fields = f.sent[0]!.payload.embeds[0]!.toJSON().fields;
    assert.equal(fields?.find((field) => field.name === '成員紀錄編號')?.value, '#1');
    assert.equal(fields?.find((field) => field.name === '影響範圍')?.value, '僅指定子區');
    assert.equal(fields?.find((field) => field.name === '處罰子區')?.value, `<#${ids.source}>`);
    assert.equal(f.sent[0]!.payload.components?.[0]?.toJSON().components[0]?.custom_id,
      `appeal:case:${ids.guild}:1:${ids.target}`);
  });
});

test('management notices default to the operated child area and retain member-ledger scope', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { logChannelId: ids.log });
    const actions = ['subarea-create', 'subarea-assign', 'subarea-delegate', 'subarea-undelegate',
      'subarea-pin', 'subarea-unpin', 'subarea-delete-message', 'subarea-slowmode',
      'subarea-rename', 'subarea-lock', 'subarea-unlock'];
    for (const action of actions) {
      await record(f.command, store, action, ids.target, 'Completed action', 'Selected child area', ids.source);
    }
    assert.equal(f.sent.length, actions.length);
    assert.ok(f.sent.every((notice) => notice.channelId === ids.source));
    assert.ok(f.fetched.every((fetch) => fetch.id === ids.source), 'child operations never fetch either configured server destination');
    for (const notice of f.sent) {
      const embed = notice.payload.embeds[0]!.toJSON();
      assert.match(embed.title ?? '', /^子區管理通知 · /);
      assert.ok(embed.fields?.some((field) => field.name === '成員紀錄編號'));
      assert.equal(embed.fields?.find((field) => field.name === '影響範圍')?.value, '僅指定子區');
      assert.deepEqual(notice.payload.components, [], 'management activities do not offer punishment appeals');
      assert.deepEqual(notice.payload.allowedMentions, { parse: [] });
    }
    assert.equal(store.listServerCases(ids.guild).length, 0);
    assert.equal(store.listMemberCases(ids.guild, ids.actor, 'performed', 100).length, actions.length);
  });
});

test('delegation and revocation notices identify the acting manager, affected member and actual child area', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { punishmentIncludeSubareas: true, logChannelId: ids.log });
    const area = '710000000000000010';
    for (const action of ['subarea-delegate', 'subarea-undelegate']) {
      await record(f.command, store, action, ids.target, '協管權限變更 @everyone', `子區 ${area}`, area);
    }
    assert.equal(f.sent.length, 2);
    for (const notice of f.sent) {
      assert.equal(notice.channelId, area, 'outside invocations notify the managed area, never the outside channel');
      const embed = notice.payload.embeds[0]!.toJSON();
      assert.match(embed.title ?? '', /^子區管理通知.*協管/);
      assert.equal(embed.fields?.find((field) => field.name === '執行者')?.value, `<@${ids.actor}>（${ids.actor}）`);
      assert.ok(embed.fields?.some((field) => field.value === `<@${ids.target}>（${ids.target}）`));
      assert.ok(embed.fields?.some((field) => field.value === `<#${area}>`));
      assert.deepEqual(notice.payload.allowedMentions, { parse: [] });
      assert.deepEqual(notice.payload.components, []);
    }
    assert.ok(store.listMemberCases(ids.guild, ids.actor).every((entry) => entry.channelId === area));
    assert.equal(store.listServerCases(ids.guild).length, 0);
  });
});

test('area and message tools with no member target still announce their selected area without inventing a member', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { punishmentIncludeSubareas: true });
    const selected = '710000000000000010';
    const actions = ['subarea-pin', 'subarea-unpin', 'subarea-delete-message', 'subarea-slowmode',
      'subarea-rename', 'subarea-lock', 'subarea-unlock'];
    for (const action of actions) {
      const result = await record(f.command, store, action, null, '管理指定子區', `子區 ${selected}；訊息 710000000000000011`, selected);
      assert.match(result, /^\n成員紀錄 #/);
      assert.doesNotMatch(result, /失敗/);
    }
    assert.equal(f.sent.length, actions.length);
    for (const notice of f.sent) {
      assert.equal(notice.channelId, selected);
      const embed = notice.payload.embeds[0]!.toJSON();
      assert.match(embed.title ?? '', /^子區管理通知/);
      assert.ok(embed.fields?.some((field) => field.value === `<#${selected}>`));
      assert.doesNotMatch(JSON.stringify(embed), /<@null>|<@undefined>/);
      assert.deepEqual(notice.payload.components, []);
    }
  });
});

test('disabling local notices suppresses management delivery independently of server announcements', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { punishmentIncludeSubareas: true, subareaNoticesEnabled: false });
    for (const [action, target] of [['subarea-delegate', ids.target], ['subarea-lock', null]] as const) {
      assert.doesNotMatch(await record(f.command, store, action, target, 'Keep only the ledger'), /失敗/);
    }
    assert.equal(f.fetched.length, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(store.listMemberCases(ids.guild, ids.actor).length, 2);
    await record(f.command, store, 'warn', ids.target, 'Server notice remains enabled');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]?.channelId, ids.notice);
    assert.equal(store.listServerCases(ids.guild).length, 1);
  });
});

test('deleted or missing child-area targets never send to the invoking or configured server channel', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { logChannelId: ids.log, punishmentIncludeSubareas: true });
    assert.equal(await record(f.command, store, 'subarea-delete', ids.actor, 'Deleted area', 'Deleted metadata', ids.source), '\n成員紀錄 #1');
    const missing = store.addCase({ guildId: ids.guild, action: 'subarea-lock', userId: null,
      moderatorId: ids.actor, reason: 'No destination', channelId: null });
    assert.deepEqual(await deliverPunishmentNotice(f.command, store, missing), { sentChannelId: null, warning: '' });
    assert.deepEqual(f.fetched, []);
    assert.deepEqual(f.sent, []);
    assert.equal(store.listMemberCases(ids.guild, ids.actor).length, 2);
    assert.equal(store.listServerCases(ids.guild).length, 0);
  });
});

test('server announcement changes and old opt-in settings cannot cancel a local notification', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { punishmentIncludeSubareas: false });
    f.state.onFetch = () => store.updateSettings(ids.guild, {
      punishmentNoticesEnabled: false, punishmentChannelId: ids.log, punishmentIncludeSubareas: false,
    });
    assert.equal(await record(f.command, store, 'subarea-delegate', ids.target, 'Independent local setting'), '\n成員紀錄 #1');
    assert.deepEqual(f.fetched.map((fetch) => fetch.id), [ids.source]);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]?.channelId, ids.source);
  });
});

test('invalid and inaccessible local destinations keep their cases without any fallback publication', async () => {
  await withStore(async (store) => {
    const setups = [
      (f: ReturnType<typeof fixture>) => { f.state.targetGuild = ids.otherGuild; },
      (f: ReturnType<typeof fixture>) => { f.state.type = ChannelType.PrivateThread; f.state.memberMissing = true; },
      (f: ReturnType<typeof fixture>) => { f.state.type = ChannelType.PublicThread; f.state.archived = true; },
    ];
    enable(store, { logChannelId: ids.log });
    for (const setup of setups) {
      const f = fixture(); setup(f);
      assert.match(await record(f.command, store, 'subarea-delegate', ids.target, 'Private child action'), /通知發送失敗/);
      assert.deepEqual(f.fetched.map((fetch) => fetch.id), [ids.source]);
      assert.deepEqual(f.sent, []);
    }
    assert.equal(store.listMemberCases(ids.guild, ids.actor).length, setups.length);
    assert.equal(store.listServerCases(ids.guild).length, 0);
  });
});

test('management delivery failure preserves its record and never falls back to the configured server log', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { punishmentIncludeSubareas: true, logChannelId: ids.log });
    f.state.sendFailures = 1;
    const result = await record(f.command, store, 'subarea-delegate', ids.target, '授予協管', `子區 ${ids.source}`);
    assert.match(result, /成員紀錄 #1/);
    assert.match(result, /通知.*失敗/);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.fetched.map((fetch) => fetch.id), [ids.source]);
    assert.equal(store.getMemberCase(ids.guild, 1, ids.actor)?.action, 'subarea-delegate');
    assert.equal(store.listServerCases(ids.guild).length, 0);
  });
});

test('disabling child-area notifications while fetching cancels a pending delegation notice', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { punishmentIncludeSubareas: true });
    f.state.onFetch = () => store.updateSettings(ids.guild, { subareaNoticesEnabled: false });
    assert.equal(await record(f.command, store, 'subarea-delegate', ids.target, '變更協管'), '\n成員紀錄 #1');
    assert.equal(f.sent.length, 0);
    assert.equal(store.listMemberCases(ids.guild, ids.actor)[0]?.action, 'subarea-delegate');
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

test('disabling local notifications during lookup cancels a restriction notice without changing its record', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { punishmentIncludeSubareas: true });
    f.state.onFetch = () => { store.updateSettings(ids.guild, { subareaNoticesEnabled: false }); };
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

test('management action selection suppresses both announcement and server log without removing appealable cases', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { logChannelId: ids.log });
    store.setNotificationActions(ids.guild, 'management', ['timeout']);
    assert.equal(await record(f.command, store, 'warn', ids.target, 'Retain this warning'), '\n本服案件 #1');
    assert.deepEqual(f.fetched, []);
    assert.equal(f.sent.length, 0);
    const original = store.getGuildCase(ids.guild, 1)!;
    assert.equal(original.action, 'warn');
    const appeal = store.createAppeal({ guildId: ids.guild, caseId: original.id, userId: ids.target, reason: 'Please review' });
    assert.equal(appeal.caseId, original.id);
    await record(f.command, store, 'timeout', ids.target, 'Selected action', '10 分鐘');
    assert.deepEqual(f.sent.map((notice) => notice.channelId), [ids.notice, ids.log]);
    assert.equal(store.listServerCases(ids.guild).length, 2);
  });
});

test('child-area action selection can omit delegation while preserving local mute notifications and all records', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { logChannelId: ids.log });
    store.setNotificationActions(ids.guild, 'subarea', ['subarea-mute']);
    await record(f.command, store, 'subarea-delegate', ids.target, 'Do not announce this grant');
    assert.deepEqual(f.fetched, []);
    await record(f.command, store, 'subarea-mute', ids.target, 'Announce this local mute');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]?.channelId, ids.source);
    assert.match(f.sent[0]!.payload.embeds[0]!.toJSON().title ?? '', /子區禁言/);
    assert.equal(store.listMemberCases(ids.guild, ids.actor).length, 2);
    assert.equal(store.listServerCases(ids.guild).length, 0);
  });
});

test('empty selections disable only notifications while kind and guild selections remain independent', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { logChannelId: ids.log });
    store.setNotificationActions(ids.guild, 'management', []);
    store.setNotificationActions(ids.otherGuild, 'subarea', []);
    await record(f.command, store, 'ban', ids.target, 'Management disabled');
    assert.equal(f.sent.length, 0);
    await record(f.command, store, 'subarea-delegate', ids.target, 'Local defaults remain enabled');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]?.channelId, ids.source);
    store.setNotificationActions(ids.guild, 'subarea', []);
    await record(f.command, store, 'subarea-mute', ids.target, 'Local disabled too');
    assert.equal(f.sent.length, 1);
    assert.equal(store.listCases(ids.guild).length, 3);
  });
});

test('removing a management action during destination lookup cancels pending announcement and server-log fallback', async () => {
  await withStore(async (store) => {
    const f = fixture();
    enable(store, { logChannelId: ids.log });
    f.state.onFetch = () => { store.setNotificationActions(ids.guild, 'management', ['timeout']); };
    assert.equal(await record(f.command, store, 'warn', ids.target, 'Filter changed'), '\n本服案件 #1');
    assert.deepEqual(f.fetched.map((fetch) => fetch.id), [ids.notice]);
    assert.deepEqual(f.sent, []);
    assert.equal(store.getGuildCase(ids.guild, 1)?.action, 'warn');
  });
});

test('removing a local action during lookup cancels only that pending local notice', async () => {
  await withStore(async (store) => {
    const f = fixture();
    f.state.onFetch = () => { store.setNotificationActions(ids.guild, 'subarea', ['subarea-mute']); };
    assert.equal(await record(f.command, store, 'subarea-delegate', ids.target, 'Filter changed'), '\n成員紀錄 #1');
    assert.deepEqual(f.fetched.map((fetch) => fetch.id), [ids.source]);
    assert.deepEqual(f.sent, []);
    assert.equal(store.getGuildCase(ids.guild, 1)?.action, 'subarea-delegate');
  });
});

test('filter read failures before or after a lookup preserve cases without any public fallback', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const stage of ['initial', 'after-fetch']) {
    await withStore(async (store) => {
      const f = fixture();
      enable(store, { logChannelId: ids.log });
      const original = store.isNotificationActionEnabled.bind(store);
      let fail = stage === 'initial';
      f.state.onFetch = () => { fail = true; };
      store.isNotificationActionEnabled = (...args) => {
        if (fail) {
          fail = false; // Even a subsequent successful read must not trigger a fallback send.
          throw new Error('Corrupted preferences');
        }
        return original(...args);
      };
      const result = await record(f.command, store, 'warn', ids.target, 'Already completed');
      assert.match(result, /本服案件 #1/);
      assert.match(result, /通知項目設定讀取失敗/);
      assert.deepEqual(f.sent, []);
      assert.deepEqual(f.fetched.map((fetch) => fetch.id), stage === 'initial' ? [] : [ids.notice]);
      assert.equal(store.getGuildCase(ids.guild, 1)?.reason, 'Already completed');
    });
  }
});

test('each guild local-notice switch applies only to its own child areas', async () => {
  await withStore(async (store) => {
    const f = fixture();
    store.updateSettings(ids.otherGuild, { subareaNoticesEnabled: false });
    await record(f.command, store, 'subarea-delegate', ids.target, 'This guild defaults on');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]?.channelId, ids.source);
    store.updateSettings(ids.guild, { subareaNoticesEnabled: false });
    store.updateSettings(ids.otherGuild, { subareaNoticesEnabled: true });
    await record(f.command, store, 'subarea-undelegate', ids.target, 'This guild is now disabled');
    assert.equal(f.sent.length, 1);
    assert.equal(f.fetched.length, 1);
    assert.equal(store.listMemberCases(ids.guild, ids.actor).length, 2);
  });
});
