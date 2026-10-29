import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PermissionFlagsBits as P, PermissionsBitField, type ChatInputCommandInteraction, type EmbedBuilder,
} from 'discord.js';
import { handleNotificationActionConfig } from '../src/notification-action-config.js';
import { notificationActionsFor } from '../src/notification-actions.js';
import { Store } from '../src/store.js';

const id = {
  guild: '960000000000000001', actor: '960000000000000002', owner: '960000000000000003',
  channel: '960000000000000004', message: '960000000000000005', command: '960000000000000006',
  otherGuild: '960000000000000007', other: '960000000000000008',
};
type Action = 'select' | 'save' | 'all' | 'none' | 'cancel' | 'timeout';
type Step = { action: Action; values?: string[]; onClick?: () => void; onUpdate?: () => void };
type Payload = { content?: string; embeds?: EmbedBuilder[]; components?: Array<{ toJSON(): unknown }>; allowedMentions?: unknown };

function fixture(steps: Step[] = [{ action: 'cancel' }]) {
  const state = { kind: 'management', memberFetches: 0, onMember: (_count: number) => {} };
  const actor = { id: id.actor, permissions: new PermissionsBitField(P.ManageGuild) };
  const replies: Payload[] = [];
  const updates: Payload[] = [];
  const timeline: Payload[] = [];
  const waits: number[] = [];
  let accepted = 0;
  let rejected = 0;
  let cursor = 0;
  const message = {
    id: id.message,
    async awaitMessageComponent(options: { time: number; filter: (interaction: typeof click) => boolean }) {
      waits.push(options.time);
      const step = steps[cursor++] ?? { action: 'timeout' };
      if (step.action === 'timeout') throw { code: 'InteractionCollectorError' };
      const click = {
        customId: `notice-actions:${id.command}:${step.action}`, user: { id: id.actor },
        guildId: id.guild, channelId: id.channel, message: { id: id.message },
        values: step.values ?? [], isStringSelectMenu: () => step.action === 'select',
        async update(payload: Payload) { updates.push(payload); timeline.push(payload); step.onUpdate?.(); },
      };
      for (const patch of [
        { user: { id: id.other } }, { guildId: id.otherGuild }, { channelId: id.other },
        { message: { id: id.other } }, { customId: `notice-actions:${id.other}:save` },
      ]) {
        assert.equal(options.filter({ ...click, ...patch }), false);
        rejected += 1;
      }
      assert.equal(options.filter(click), true);
      accepted += 1;
      step.onClick?.();
      return click;
    },
  };
  // The actual collector supplies these same message/user/guild identifiers.
  const click = { customId: '', user: { id: '' }, guildId: '', channelId: '', message: { id: '' },
    values: [] as string[], isStringSelectMenu: () => false, async update(_payload: Payload) {} };
  const guild = {
    id: id.guild, ownerId: id.owner, roles: { async fetch() {} },
    members: { async fetch(options: { user: string; force: boolean }) {
      assert.equal(options.user, id.actor); assert.equal(options.force, true);
      state.onMember(++state.memberFetches); return actor;
    } },
  };
  const command = {
    id: id.command, guildId: id.guild, channelId: id.channel, guild, user: { id: id.actor },
    options: { getString: (name: string, required: boolean) => {
      assert.equal(name, 'kind'); assert.equal(required, true); return state.kind;
    } },
    async editReply(payload: Payload) { replies.push(payload); timeline.push(payload); return message; },
  } as unknown as ChatInputCommandInteraction<'cached'>;
  return { command, guild, actor, state, replies, updates, timeline, waits,
    output: () => JSON.stringify(timeline),
    clicks: () => ({ accepted, rejected }),
  };
}

function withStore(run: (store: Store) => Promise<void>) {
  return async () => { const store = new Store(':memory:'); try { await run(store); } finally { store.close(); } };
}

test('the private panel offers all current items as checked by default and binds every component to its origin', withStore(async (store) => {
  const f = fixture();
  await handleNotificationActionConfig(f.command, store);
  const row = f.replies[0]?.components?.[0]?.toJSON() as {
    components: Array<{ min_values: number; max_values: number; options: Array<{ label: string; value: string; default: boolean }> }>;
  };
  const menu = row.components[0]!;
  assert.equal(menu.min_values, 0); assert.equal(menu.max_values, notificationActionsFor('management').length);
  assert.deepEqual(menu.options.map((option) => option.value), notificationActionsFor('management'));
  assert.ok(menu.options.every((option) => option.default && /\p{Script=Han}/u.test(option.label)));
  assert.deepEqual(f.replies[0]?.allowedMentions, { parse: [] });
  assert.deepEqual(f.clicks(), { accepted: 1, rejected: 5 });
  assert.match(f.output(), /處罰公告與管理日誌/); assert.match(f.output(), /處罰私訊另由原設定控制/);
  assert.deepEqual(store.listCases(id.guild), []);
}));

test('saving a staged subset changes only the selected guild and kind while retaining masters and destinations', withStore(async (store) => {
  store.updateSettings(id.guild, { logChannelId: id.other, punishmentChannelId: id.channel,
    punishmentNoticesEnabled: false, punishmentDmEnabled: false, subareaNoticesEnabled: false });
  const settings = store.getSettings(id.guild);
  const foreign = store.getNotificationActions(id.otherGuild, 'management');
  const local = store.getNotificationActions(id.guild, 'subarea');
  const f = fixture([{ action: 'select', values: ['kick', 'warn'] }, { action: 'save' }]);
  await handleNotificationActionConfig(f.command, store);
  assert.deepEqual(store.getNotificationActions(id.guild, 'management'), ['warn', 'kick']);
  assert.deepEqual(store.getSettings(id.guild), settings);
  assert.deepEqual(store.getNotificationActions(id.guild, 'subarea'), local);
  assert.deepEqual(store.getNotificationActions(id.otherGuild, 'management'), foreign);
  const entry = store.listCases(id.guild)[0]!;
  assert.equal(entry.action, 'config'); assert.equal(entry.scope, 'member');
  assert.equal(store.listCases(id.guild).length, 1);
  assert.match(f.replies.at(-1)?.content ?? '', /已更新管理通知項目/);
  assert.equal(f.state.memberFetches, 2);
}));

test('clear and empty multiselect both save no notifications; selecting all restores the catalog', withStore(async (store) => {
  for (const step of [{ action: 'none' } as Step, { action: 'select', values: [] } as Step]) {
    const f = fixture([step, { action: 'save' }]); f.state.kind = 'subarea';
    await handleNotificationActionConfig(f.command, store);
    assert.deepEqual(store.getNotificationActions(id.guild, 'subarea'), []);
    assert.match(f.replies.at(-1)?.content ?? '', /全部不通知/);
  }
  const restored = fixture([{ action: 'all' }, { action: 'save' }]); restored.state.kind = 'subarea';
  await handleNotificationActionConfig(restored.command, store);
  assert.deepEqual(store.getNotificationActions(id.guild, 'subarea'), notificationActionsFor('subarea'));
}));

test('cancel and timeout discard staged edits and never create configuration records', withStore(async (store) => {
  for (const action of ['cancel', 'timeout'] as const) {
    const f = fixture([{ action: 'select', values: ['warn'] }, { action }]);
    await handleNotificationActionConfig(f.command, store);
    assert.deepEqual(store.getNotificationActions(id.guild, 'management'), notificationActionsFor('management'));
    assert.deepEqual(store.listCases(id.guild), []);
    assert.match(f.output(), action === 'cancel' ? /已取消/ : /已逾時/);
    assert.equal(f.timeline.at(-1)?.components?.length, 0);
  }
}));

test('the absolute panel deadline cannot be extended by making another selection', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:');
  try {
    const f = fixture([{ action: 'select', values: ['warn'], onUpdate: () => { now += 121_000; } }, { action: 'save' }]);
    await handleNotificationActionConfig(f.command, store);
    assert.equal(f.waits.length, 1);
    assert.ok(f.waits[0]! > 0 && f.waits[0]! <= 120_000);
    assert.match(f.replies.at(-1)?.content ?? '', /已逾時/);
    assert.deepEqual(store.getNotificationActions(id.guild, 'management'), notificationActionsFor('management'));
    assert.deepEqual(store.listCases(id.guild), []);
  } finally { store.close(); }
});

test('management grants and local ownership cannot open the configuration panel', withStore(async (store) => {
  const f = fixture(); f.actor.permissions = new PermissionsBitField();
  for (const scope of ['warn', 'timeout', 'kick', 'ban', 'clear'] as const) store.setGrant(id.guild, id.actor, scope, id.owner);
  store.setSubarea(id.guild, id.channel, id.actor);
  await assert.rejects(handleNotificationActionConfig(f.command, store), /原生.*管理伺服器/);
  assert.equal(f.replies.length, 0); assert.deepEqual(store.listCases(id.guild), []);
}));

test('guild owners and native administrators may save without a ManageGuild role', withStore(async (store) => {
  for (const owner of [true, false]) {
    const f = fixture([{ action: 'none' }, { action: 'save' }]);
    f.actor.permissions = new PermissionsBitField(owner ? [] : P.Administrator);
    if (owner) f.guild.ownerId = id.actor;
    await handleNotificationActionConfig(f.command, store);
    assert.deepEqual(store.getNotificationActions(id.guild, 'management'), []);
  }
}));

test('revocation during component delivery or the final native member fetch prevents saving', withStore(async (store) => {
  for (const stage of ['click', 'fetch']) {
    const f = fixture([{ action: 'none' }, { action: 'save', onClick: () => {
      if (stage === 'click') f.actor.permissions.remove(P.ManageGuild);
    } }]);
    f.state.onMember = (count) => { if (stage === 'fetch' && count === 2) f.actor.permissions.remove(P.ManageGuild); };
    await assert.rejects(handleNotificationActionConfig(f.command, store), /原生.*管理伺服器/);
    assert.deepEqual(store.getNotificationActions(id.guild, 'management'), notificationActionsFor('management'));
    assert.deepEqual(store.listCases(id.guild), []);
  }
}));

test('a competing same-kind update is retained instead of being overwritten by a stale panel', withStore(async (store) => {
  const f = fixture([{ action: 'none' }, { action: 'save', onClick: () => {
    store.setNotificationActions(id.guild, 'management', ['ban']);
  } }]);
  await assert.rejects(handleNotificationActionConfig(f.command, store), /其他管理員剛剛修改/);
  assert.deepEqual(store.getNotificationActions(id.guild, 'management'), ['ban']);
  assert.deepEqual(store.listCases(id.guild), []);
}));

test('an independent kind updated while a panel is open does not cancel or overwrite that panel', withStore(async (store) => {
  const f = fixture([{ action: 'select', values: ['warn'] }, { action: 'save', onClick: () => {
    store.setNotificationActions(id.guild, 'subarea', ['subarea-delegate']);
  } }]);
  await handleNotificationActionConfig(f.command, store);
  assert.deepEqual(store.getNotificationActions(id.guild, 'management'), ['warn']);
  assert.deepEqual(store.getNotificationActions(id.guild, 'subarea'), ['subarea-delegate']);
}));

test('invalid kinds and tampered selections fail before any configuration write', withStore(async (store) => {
  const invalid = fixture(); invalid.state.kind = 'foreign';
  await assert.rejects(handleNotificationActionConfig(invalid.command, store), /請選擇管理通知或子區通知/);
  assert.equal(invalid.replies.length, 0);
  for (const values of [['subarea-delegate'], ['warn', 'warn'], ['unknown-action']]) {
    const f = fixture([{ action: 'select', values }, { action: 'save' }]);
    await assert.rejects(handleNotificationActionConfig(f.command, store), /通知項目已失效/);
    assert.deepEqual(store.getNotificationActions(id.guild, 'management'), notificationActionsFor('management'));
    assert.equal(f.updates.at(-1)?.components?.length, 0);
  }
  assert.deepEqual(store.listCases(id.guild), []);
}));
