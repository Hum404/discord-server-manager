import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChannelType, Collection, OverwriteType, PermissionFlagsBits, PermissionsBitField,
  type ChatInputCommandInteraction, type GuildMember, type Interaction, type TextChannel,
} from 'discord.js';
import { handleAppealCommand, handleAppealInteraction, notifyPunishment } from '../src/appeals.js';
import { assertPrivateAppealChannel } from '../src/appeal-privacy.js';
import { Store } from '../src/store.js';

const ids = {
  guild: '100000000000000001', otherGuild: '100000000000000002',
  user: '100000000000000003', other: '100000000000000004',
  reviewer: '100000000000000005', owner: '100000000000000006',
  bot: '100000000000000007', channel: '100000000000000008',
  otherChannel: '100000000000000009', message: '100000000000000010',
};
type Payload = Record<string, unknown>;

function fixture() {
  const replies: Payload[] = [];
  const modals: Array<{ custom_id: string; components?: unknown[] }> = [];
  const sent: Payload[] = [];
  const edited: Payload[] = [];
  const dms: Payload[] = [];
  const state = {
    nativeStaff: true, publicChannel: false, everyoneUnknown: false, roleLeak: false, roleUnknown: false,
    postFails: false, dmFails: false,
    memberFetches: 0, roleFetches: 0, guildFetches: 0, dmAttempts: 0, punishmentCalls: 0,
  };
  const everyone = { id: ids.guild, name: '@everyone', managed: false, permissions: new PermissionsBitField(), tags: null };
  const staffRole = { id: '100000000000000020', name: 'Staff', managed: false,
    permissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]), tags: null };
  const memberRole = { id: '100000000000000021', name: 'Members', managed: false,
    permissions: new PermissionsBitField(), tags: null };
  const botRole = { id: '100000000000000022', name: 'Bot', managed: true,
    permissions: new PermissionsBitField(), tags: { botId: ids.bot } };
  const bot = { id: ids.bot };
  const channel = {
    id: ids.channel, type: ChannelType.GuildText,
    guild: {} as object,
    permissionOverwrites: { cache: new Collection<string, { id: string; type: number; allow: PermissionsBitField; deny: PermissionsBitField }>() },
    permissionsFor(target: unknown) {
      if (!target) return null;
      if (target === everyone && state.everyoneUnknown) return null;
      if ((target as { id?: string })?.id === memberRole.id) {
        if (state.roleUnknown) return null;
        return new PermissionsBitField(state.roleLeak ? [PermissionFlagsBits.ViewChannel] : []);
      }
      return new PermissionsBitField(target === everyone
        ? state.publicChannel ? [PermissionFlagsBits.ViewChannel] : []
        : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
    },
    async send(payload: Payload) {
      if (state.postFails) throw { code: 50013 };
      sent.push(payload);
      return { id: ids.message };
    },
    messages: { async fetch() { return { async edit(payload: Payload) { edited.push(payload); } }; } },
  };
  const guild = {
    id: ids.guild, name: 'Test community', ownerId: ids.owner,
    roles: { everyone, cache: new Collection<string, { id: string; name: string; managed: boolean;
      permissions: PermissionsBitField; tags: { botId: string } | null }>([
      [everyone.id, everyone], [staffRole.id, staffRole], [memberRole.id, memberRole], [botRole.id, botRole],
    ]), async fetch() { state.roleFetches += 1; } },
    members: {
      async fetch({ user, force }: { user: string; force: boolean }) {
        assert.equal(force, true);
        state.memberFetches += 1;
        return { id: user, guild, permissions: new PermissionsBitField(state.nativeStaff && user === ids.reviewer ? [PermissionFlagsBits.ManageGuild] : []) };
      },
      async fetchMe() { return bot; },
    },
    channels: { async fetch(id: string) { return id === ids.channel ? channel : null; } },
    bans: { async remove() { state.punishmentCalls += 1; } },
  };
  channel.guild = guild;
  const client = {
    user: { id: ids.bot },
    guilds: { async fetch(id: string) {
      state.guildFetches += 1;
      assert.equal(id, ids.guild);
      return guild;
    } },
    users: { async fetch(id: string) {
      assert.equal(id, ids.user);
      return { async send(payload: Payload) {
        state.dmAttempts += 1;
        if (state.dmFails) throw { code: 50007 };
        dms.push(payload);
      } };
    } },
  };

  function interaction(kind: 'command' | 'button' | 'modal', options: {
    userId?: string; guildId?: string | null; subcommand?: string; customId?: string;
    integers?: Record<string, number>; strings?: Record<string, string>;
    fields?: Record<string, string>; channelId?: string; messageId?: string;
  } = {}) {
    const guildId = options.guildId === undefined ? null : options.guildId;
    const value = {
      commandName: 'appeal', user: { id: options.userId ?? ids.user },
      guildId, guild: guildId ? guild : null, client,
      channelId: options.channelId ?? (guildId ? ids.channel : 'dm'),
      message: { id: options.messageId ?? ids.message },
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
      customId: options.customId ?? '', deferred: false, replied: false,
      isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal',
      isFromMessage: () => true, inGuild: () => guildId !== null,
      options: {
        getSubcommand: () => options.subcommand ?? 'submit',
        getInteger: (name: string) => options.integers?.[name] ?? null,
        getString: (name: string) => options.strings?.[name] ?? null,
      },
      fields: { getTextInputValue: (name: string) => options.fields?.[name] ?? '' },
      async deferReply(payload: Payload = {}) { value.deferred = true; replies.push({ defer: true, ...payload }); },
      async reply(payload: Payload) { value.replied = true; replies.push(payload); },
      async editReply(payload: Payload) { replies.push(payload); },
      async showModal(modal: { toJSON(): unknown }) {
        value.replied = true;
        modals.push(modal.toJSON() as { custom_id: string; components?: unknown[] });
      },
    };
    return value;
  }
  return { state, replies, modals, sent, edited, dms, guild, channel, client, interaction };
}

function originalCase(store: Store, userId = ids.user, guildId = ids.guild) {
  return store.addCase({ guildId, userId, moderatorId: ids.reviewer, action: 'ban', reason: 'Original private punishment reason' });
}

function content(replies: Payload[]): string {
  return replies.map((reply) => String(reply.content ?? '')).join('\n');
}

test('privacy fails closed for missing everyone and unknown role permissions', async () => {
  const missing = fixture();
  missing.guild.roles.everyone = undefined as unknown as typeof missing.guild.roles.everyone;
  await assert.rejects(assertPrivateAppealChannel(missing.channel as unknown as TextChannel, ids.bot), /非管理人員/);
  const unknown = fixture();
  unknown.state.roleUnknown = true;
  await assert.rejects(assertPrivateAppealChannel(unknown.channel as unknown as TextChannel, ids.bot), /非管理人員/);
});

test('privacy rejects explicit non-staff member visibility but allows explicit native staff', async () => {
  const f = fixture();
  const overwrite = { id: ids.user, type: OverwriteType.Member,
    allow: new PermissionsBitField([PermissionFlagsBits.ViewChannel]), deny: new PermissionsBitField() };
  f.channel.permissionOverwrites.cache.set(ids.user, overwrite);
  await assert.rejects(assertPrivateAppealChannel(f.channel as unknown as TextChannel, ids.bot), /非管理人員/);
  f.channel.permissionOverwrites.cache.delete(ids.user);
  f.channel.permissionOverwrites.cache.set(ids.reviewer, { ...overwrite, id: ids.reviewer });
  await assert.doesNotReject(assertPrivateAppealChannel(f.channel as unknown as TextChannel, ids.bot));
  f.state.nativeStaff = false;
  await assert.rejects(assertPrivateAppealChannel(f.channel as unknown as TextChannel, ids.bot), /非管理人員/);
});

test('DM appeal buttons are bound to the applicant and original case guild', async () => {
  const store = new Store(':memory:');
  try {
    originalCase(store);
    const own = fixture();
    const customId = `appeal:open:${ids.guild}:${ids.user}`;
    assert.equal(await handleAppealInteraction(own.interaction('button', { customId }) as unknown as Interaction, store), true);
    assert.equal(own.modals[0]?.custom_id, `appeal:submit:${ids.guild}:${ids.user}`);
    for (const options of [{ userId: ids.other }, { guildId: ids.otherGuild }]) {
      const denied = fixture();
      await handleAppealInteraction(denied.interaction('button', { customId, ...options }) as unknown as Interaction, store);
      assert.equal(denied.modals.length, 0);
      assert.match(content(denied.replies), /找不到可供你申訴/);
    }
    assert.equal(store.listAppeals(ids.guild).length, 0);
  } finally { store.close(); }
});

test('submit opens a form only for an owned appealable case in the current guild', async () => {
  const store = new Store(':memory:');
  try {
    const own = originalCase(store);
    const other = originalCase(store, ids.other);
    const otherGuild = originalCase(store, ids.user, ids.otherGuild);
    const valid = fixture();
    await handleAppealCommand(valid.interaction('command', { integers: { case: own.id } }) as unknown as ChatInputCommandInteraction, store);
    assert.equal(valid.modals.length, 1);
    for (const id of [other.id, otherGuild.id]) {
      const denied = fixture();
      await handleAppealCommand(denied.interaction('command', { guildId: ids.guild, integers: { case: id } }) as unknown as ChatInputCommandInteraction, store);
      assert.equal(denied.modals.length, 0);
      assert.match(content(denied.replies), /找不到可供你申訴/);
      assert.doesNotMatch(content(denied.replies), /Original private/);
    }
  } finally { store.close(); }
});

test('submission persists without a notification channel and duplicate submissions reuse the ticket', async () => {
  const store = new Store(':memory:');
  try {
    const original = originalCase(store);
    const f = fixture();
    const options = { customId: `appeal:submit:${ids.guild}:${ids.user}`, fields: { case_id: String(original.id), reason: 'Please reconsider @everyone' } };
    await handleAppealInteraction(f.interaction('modal', options) as unknown as Interaction, store);
    const appeal = store.getAppealForCase(ids.guild, original.id, ids.user);
    assert.ok(appeal);
    assert.equal(appeal.status, 'open');
    assert.equal(appeal.reason, 'Please reconsider @everyone');
    assert.equal(f.state.guildFetches, 0);
    assert.match(content(f.replies), /已儲存.*等待管理員審核/);
    assert.match(content(f.replies), /通知未送達/);
    await handleAppealInteraction(f.interaction('modal', options) as unknown as Interaction, store);
    assert.equal(store.listAppeals(ids.guild).length, 1);
    assert.match(content(f.replies), /已有申訴工單.*不會重複建立/);
    assert.equal(store.listCases(ids.guild).filter((entry) => entry.action === 'appeal-submit').length, 1);
  } finally { store.close(); }
});

test('private staff notification persists message binding and suppresses all mentions', async () => {
  const store = new Store(':memory:');
  try {
    store.updateSettings(ids.guild, { appealChannelId: ids.channel });
    const original = originalCase(store);
    const f = fixture();
    await handleAppealInteraction(f.interaction('modal', {
      customId: `appeal:submit:${ids.guild}:${ids.user}`,
      fields: { case_id: String(original.id), reason: 'Private explanation @everyone' },
    }) as unknown as Interaction, store);
    const appeal = store.getAppealForCase(ids.guild, original.id, ids.user)!;
    assert.equal(appeal.channelId, ids.channel);
    assert.equal(appeal.messageId, ids.message);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0]?.allowedMentions, { parse: [] });
    assert.ok(f.sent[0]?.components);
  } finally { store.close(); }
});

test('public, unknown or non-staff role visibility and failed posting never leak or lose the saved appeal', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const failure of ['public', 'unknown', 'role', 'post'] as const) {
    const store = new Store(':memory:');
    try {
      store.updateSettings(ids.guild, { appealChannelId: ids.channel });
      const original = originalCase(store);
      const f = fixture();
      f.state.publicChannel = failure === 'public';
      f.state.everyoneUnknown = failure === 'unknown';
      f.state.roleLeak = failure === 'role';
      f.state.postFails = failure === 'post';
      await handleAppealInteraction(f.interaction('modal', {
        customId: `appeal:submit:${ids.guild}:${ids.user}`,
        fields: { case_id: String(original.id), reason: 'Never post this publicly' },
      }) as unknown as Interaction, store);
      assert.equal(store.listAppeals(ids.guild).length, 1);
      assert.equal(f.sent.length, 0);
      assert.equal(store.listAppeals(ids.guild)[0]?.messageId, null);
      assert.match(content(f.replies), /已儲存/);
    } finally { store.close(); }
  }
});

test('a forged submission cannot change applicant, guild or another user case', async () => {
  const store = new Store(':memory:');
  try {
    const original = originalCase(store);
    const other = originalCase(store, ids.other);
    for (const options of [
      { userId: ids.other, caseId: original.id },
      { guildId: ids.otherGuild, caseId: original.id },
      { caseId: other.id },
    ]) {
      const f = fixture();
      await handleAppealInteraction(f.interaction('modal', {
        customId: `appeal:submit:${ids.guild}:${ids.user}`,
        ...options, fields: { case_id: String(options.caseId), reason: 'Forged submission' },
      }) as unknown as Interaction, store);
      assert.equal(store.listAppeals(ids.guild).length, 0);
      assert.equal(f.sent.length, 0);
      assert.match(content(f.replies), /找不到可供你申訴/);
    }
  } finally { store.close(); }
});

test('status never exposes another applicant ticket and queue/review require native management', async () => {
  const store = new Store(':memory:');
  try {
    const original = originalCase(store, ids.other);
    const appeal = store.createAppeal({ guildId: ids.guild, caseId: original.id, userId: ids.other, reason: 'Other private content' });
    const applicant = fixture();
    await handleAppealCommand(applicant.interaction('command', { subcommand: 'status', integers: { id: appeal.id } }) as unknown as ChatInputCommandInteraction, store);
    assert.match(content(applicant.replies), /找不到可供你申訴/);
    assert.doesNotMatch(content(applicant.replies), /Other private content/);
    store.setGrant(ids.guild, ids.reviewer, 'ban', ids.owner);
    for (const subcommand of ['queue', 'review']) {
      const denied = fixture();
      denied.state.nativeStaff = false;
      await handleAppealCommand(denied.interaction('command', {
        userId: ids.reviewer, guildId: ids.guild, subcommand,
        integers: { id: appeal.id }, strings: { result: 'accepted', reason: 'Unauthorized' },
      }) as unknown as ChatInputCommandInteraction, store);
      assert.match(content(denied.replies), /只有具備原生/);
      assert.equal(store.getAppeal(appeal.id)?.status, 'open');
      assert.equal(denied.sent.length, 0);
    }
  } finally { store.close(); }
});

test('review is one-time and survives failed applicant DMs without reversing punishment', async (t) => {
  t.mock.method(console, 'error', () => {});
  const store = new Store(':memory:');
  try {
    const original = originalCase(store);
    const appeal = store.createAppeal({ guildId: ids.guild, caseId: original.id, userId: ids.user, reason: 'Please review' });
    const f = fixture();
    f.state.dmFails = true;
    const options = { userId: ids.reviewer, guildId: ids.guild, subcommand: 'review', integers: { id: appeal.id }, strings: { result: 'accepted', reason: 'Verified evidence' } };
    await handleAppealCommand(f.interaction('command', options) as unknown as ChatInputCommandInteraction, store);
    assert.equal(store.getAppeal(appeal.id)?.status, 'accepted');
    assert.equal(store.getAppeal(appeal.id)?.response, 'Verified evidence');
    assert.equal(f.state.dmAttempts, 1);
    assert.equal(f.state.punishmentCalls, 0);
    assert.match(content(f.replies), /無法私訊通知申訴者.*已保存/);
    await handleAppealCommand(f.interaction('command', { ...options, strings: { result: 'rejected', reason: 'Second reviewer' } }) as unknown as ChatInputCommandInteraction, store);
    assert.equal(store.getAppeal(appeal.id)?.status, 'accepted');
    assert.equal(f.state.dmAttempts, 1);
    assert.equal(store.listCases(ids.guild).filter((entry) => entry.action === 'appeal-review').length, 1);
    assert.match(content(f.replies), /未重複變更/);
  } finally { store.close(); }
});

test('staff review buttons reject unrelated message/channel bindings', async () => {
  const store = new Store(':memory:');
  try {
    const original = originalCase(store);
    const appeal = store.createAppeal({ guildId: ids.guild, caseId: original.id, userId: ids.user, reason: 'Review' });
    store.setAppealMessage(appeal.id, ids.guild, ids.channel, ids.message);
    for (const options of [{ channelId: ids.otherChannel }, { messageId: '100000000000000099' }]) {
      const f = fixture();
      await handleAppealInteraction(f.interaction('button', {
        userId: ids.reviewer, guildId: ids.guild, customId: `appeal:review:${appeal.id}:accepted`, ...options,
      }) as unknown as Interaction, store);
      assert.equal(f.modals.length, 0);
      assert.equal(store.getAppeal(appeal.id)?.status, 'open');
      assert.match(content(f.replies), /不屬於目前的申訴工單/);
    }
  } finally { store.close(); }
});

test('review forms are bound to the reviewer and recheck current native permissions on submit', async () => {
  const store = new Store(':memory:');
  try {
    const original = originalCase(store);
    const appeal = store.createAppeal({ guildId: ids.guild, caseId: original.id, userId: ids.user, reason: 'Review' });
    store.setAppealMessage(appeal.id, ids.guild, ids.channel, ids.message);
    const f = fixture();
    await handleAppealInteraction(f.interaction('button', { userId: ids.reviewer, guildId: ids.guild, customId: `appeal:review:${appeal.id}:accepted` }) as unknown as Interaction, store);
    const customId = f.modals[0]?.custom_id;
    assert.equal(customId, `appeal:decision:${appeal.id}:accepted:${ids.reviewer}`);
    await handleAppealInteraction(f.interaction('modal', { userId: ids.other, guildId: ids.guild, customId, fields: { response: 'Forged reviewer' } }) as unknown as Interaction, store);
    assert.equal(store.getAppeal(appeal.id)?.status, 'open');
    f.state.nativeStaff = false;
    await handleAppealInteraction(f.interaction('modal', { userId: ids.reviewer, guildId: ids.guild, customId, fields: { response: 'Permission was revoked' } }) as unknown as Interaction, store);
    assert.equal(store.getAppeal(appeal.id)?.status, 'open');
    assert.equal(f.state.memberFetches, 1);
    assert.match(content(f.replies), /只有具備原生/);
  } finally { store.close(); }
});

test('punishment notifications contain a bound DM appeal entry and closed DMs do not throw', async (t) => {
  t.mock.method(console, 'error', () => {});
  const payloads: Payload[] = [];
  let calls = 0;
  const target = {
    id: ids.user, guild: { id: ids.guild, name: 'Server' },
    async send(payload: Payload) { payloads.push(payload); },
    async ban() { calls += 1; }, async kick() { calls += 1; }, async timeout() { calls += 1; },
  };
  assert.equal(await notifyPunishment(target as unknown as GuildMember, 'ban', 'Original reason'), true);
  const rows = payloads[0]?.components as Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>;
  assert.equal(rows[0]?.toJSON().components[0]?.custom_id, `appeal:open:${ids.guild}:${ids.user}`);
  assert.deepEqual(payloads[0]?.allowedMentions, { parse: [] });
  target.send = async () => { throw { code: 50007 }; };
  assert.equal(await notifyPunishment(target as unknown as GuildMember, 'kick', 'Original reason'), false);
  assert.equal(calls, 0);
});
