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
type Action = 'kind' | 'select' | 'save' | 'all' | 'none' | 'cancel' | 'timeout';
type Step = { action: Action; values?: string[]; onClick?: () => void; onUpdate?: () => void };
type Payload = { content?: string; embeds?: EmbedBuilder[]; components?: Array<{ toJSON(): unknown }>; allowedMentions?: unknown };

type Control = { custom_id: string; label?: string; min_values?: number; max_values?: number;
  options?: Array<{ label: string; value: string; default?: boolean }> };

function controls(payload: Payload): Control[] {
  return (payload.components ?? []).flatMap((row) => (row.toJSON() as { components: Control[] }).components);
}

function controlFor(payload: Payload, action: Exclude<Action, 'timeout'>): Control {
  const labels = { save: '儲存', all: '全選', none: '清空', cancel: '關閉' };
  const found = controls(payload).find((control) => action === 'kind'
    ? control.options?.some((option) => option.value === 'management') && control.options?.some((option) => option.value === 'subarea')
    : action === 'select' ? control.options?.some((option) => option.value.startsWith('subarea-') || option.value === 'warn')
      : control.label === labels[action]);
  assert.ok(found, `The current card has no ${action} control`);
  return found;
}

function fixture(steps: Step[] = [{ action: 'cancel' }], kind: string | null = 'management') {
  const state = { kind, memberFetches: 0, onMember: (_count: number) => {} };
  const actor = { id: id.actor, permissions: new PermissionsBitField(P.ManageGuild) };
  const replies: Payload[] = [];
  const updates: Payload[] = [];
  const timeline: Payload[] = [];
  const rendered: Payload[] = [];
  const waits: number[] = [];
  let current: Payload = {};
  let accepted = 0;
  let rejected = 0;
  let staleRejected = 0;
  let cursor = 0;
  function capture(payload: Payload) {
    timeline.push(payload); current = { ...current, ...payload };
    if (payload.components?.length) rendered.push(current);
  }
  const message = {
    id: id.message,
    async awaitMessageComponent(options: { time: number; filter: (interaction: typeof click) => boolean }) {
      waits.push(options.time);
      const step = steps[cursor++] ?? { action: 'timeout' };
      if (step.action === 'timeout') throw { code: 'InteractionCollectorError' };
      const control = controlFor(current, step.action);
      const click = {
        customId: control.custom_id, user: { id: id.actor },
        guildId: id.guild, channelId: id.channel, message: { id: id.message },
        values: step.values ?? [], isStringSelectMenu: () => step.action === 'select' || step.action === 'kind',
        async update(payload: Payload) { updates.push(payload); capture(payload); step.onUpdate?.(); },
        async deferUpdate() { step.onUpdate?.(); },
      };
      for (const patch of [
        { user: { id: id.other } }, { guildId: id.otherGuild }, { channelId: id.other },
        { message: { id: id.other } }, { customId: `notice-actions:${id.other}:save` },
      ]) {
        assert.equal(options.filter({ ...click, ...patch }), false);
        rejected += 1;
      }
      const presentIds = new Set(controls(current).map((entry) => entry.custom_id));
      const previousIds = new Set(rendered.slice(0, -1).flatMap((payload) => controls(payload).map((entry) => entry.custom_id)));
      for (const customId of previousIds) {
        assert.equal(presentIds.has(customId), false, 'each rendered view must retire all prior control IDs');
        assert.equal(options.filter({ ...click, customId }), false, 'a stale control cannot modify the current card');
        staleRejected += 1;
      }
      assert.equal(options.filter(click), true);
      accepted += 1;
      step.onClick?.();
      return click;
    },
  };
  // The actual collector supplies these same message/user/guild identifiers.
  const click = { customId: '', user: { id: '' }, guildId: '', channelId: '', message: { id: '' },
    values: [] as string[], isStringSelectMenu: () => false, async update(_payload: Payload) {}, async deferUpdate() {} };
  const guild = {
    id: id.guild, ownerId: id.owner, roles: { async fetch() {} },
    members: { async fetch(options: { user: string; force: boolean }) {
      assert.equal(options.user, id.actor); assert.equal(options.force, true);
      state.onMember(++state.memberFetches); return actor;
    } },
  };
  const command = {
    id: id.command, guildId: id.guild, channelId: id.channel, guild, user: { id: id.actor },
    options: { getString: (name: string, required?: boolean) => {
      assert.equal(name, 'kind'); assert.notEqual(required, true); return state.kind;
    } },
    async editReply(payload: Payload) { replies.push(payload); capture(payload); return message; },
  } as unknown as ChatInputCommandInteraction<'cached'>;
  return { command, guild, actor, state, replies, updates, timeline, rendered, waits,
    output: () => JSON.stringify(timeline),
    clicks: () => ({ accepted, rejected, staleRejected }),
  };
}

function withStore(run: (store: Store) => Promise<void>) {
  return async () => { const store = new Store(':memory:'); try { await run(store); } finally { store.close(); } };
}

test('opening without arguments shows a private settings card with one category dropdown', withStore(async (store) => {
  const f = fixture([{ action: 'timeout' }], null);
  await handleNotificationActionConfig(f.command, store);
  const first = f.replies[0]!;
  assert.match(JSON.stringify(first.embeds), /通知設定/);
  assert.equal(first.components?.length, 1);
  const menu = controlFor(first, 'kind');
  assert.deepEqual(menu.options?.map((option) => ({ label: option.label, value: option.value })), [
    { label: '管理通知', value: 'management' }, { label: '子區通知', value: 'subarea' },
  ]);
  assert.deepEqual(first.allowedMentions, { parse: [] });
  assert.deepEqual(store.listCases(id.guild), []);
}));

test('one card preserves each category draft and saves both categories independently', withStore(async (store) => {
  const f = fixture([
    { action: 'kind', values: ['management'] }, { action: 'select', values: ['warn'] },
    { action: 'kind', values: ['subarea'] }, { action: 'select', values: ['subarea-delegate'] },
    { action: 'save' }, { action: 'kind', values: ['management'] }, { action: 'save' }, { action: 'cancel' },
  ], null);
  await handleNotificationActionConfig(f.command, store);
  assert.deepEqual(store.getNotificationActions(id.guild, 'management'), ['warn']);
  assert.deepEqual(store.getNotificationActions(id.guild, 'subarea'), ['subarea-delegate']);
  assert.equal(store.listCases(id.guild).length, 2);
  const managementMenus = f.rendered.map((payload) => controls(payload).find((control) =>
    control.options?.some((option) => option.value === 'warn'))).filter((menu) => !!menu);
  assert.ok(managementMenus.some((menu) => menu.options?.filter((option) => option.default).map((option) => option.value).join() === 'warn'),
    'returning to management restores its staged selection');
  assert.ok(f.rendered.some((payload) => payload.components?.length === 3), 'the card combines type, action and save controls');
  assert.ok(f.clicks().staleRejected > 0, 'old category/revision controls cannot affect the active category');
}));

test('closing or timing out retains saved preferences and discards only later unsaved edits', withStore(async (store) => {
  for (const action of ['cancel', 'timeout'] as const) {
    store.setNotificationActions(id.guild, 'management', notificationActionsFor('management'));
    const before = store.listCases(id.guild).length;
    const f = fixture([{ action: 'select', values: ['warn'] }, { action: 'save' },
      { action: 'select', values: ['ban'] }, { action }]);
    await handleNotificationActionConfig(f.command, store);
    assert.deepEqual(store.getNotificationActions(id.guild, 'management'), ['warn']);
    assert.equal(store.listCases(id.guild).length, before + 1);
    assert.match(f.timeline.at(-1)?.content ?? '', /已儲存/);
    assert.equal(f.timeline.at(-1)?.components?.length, 0);
  }
}));

test('repeated save without changes does not create duplicate configuration records', withStore(async (store) => {
  const f = fixture([{ action: 'select', values: ['warn'] }, { action: 'save' }, { action: 'save' }, { action: 'cancel' }]);
  await handleNotificationActionConfig(f.command, store);
  assert.deepEqual(store.getNotificationActions(id.guild, 'management'), ['warn']);
  assert.equal(store.listCases(id.guild).length, 1);
  assert.ok(f.clicks().staleRejected > 0);
}));

test('saving keeps the original deadline instead of extending the card lifetime', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:');
  try {
    const f = fixture([{ action: 'select', values: ['warn'] },
      { action: 'save', onUpdate: () => { now += 121_000; } }, { action: 'cancel' }]);
    await handleNotificationActionConfig(f.command, store);
    assert.equal(f.waits.length, 2);
    assert.ok(f.waits.every((remaining) => remaining > 0 && remaining <= 120_000));
    assert.deepEqual(store.getNotificationActions(id.guild, 'management'), ['warn']);
    assert.equal(store.listCases(id.guild).length, 1);
    assert.match(f.timeline.at(-1)?.content ?? '', /逾時/);
    assert.match(f.timeline.at(-1)?.content ?? '', /已儲存/);
  } finally { store.close(); }
});

test('the private panel offers all current items as checked by default and binds every component to its origin', withStore(async (store) => {
  const f = fixture();
  await handleNotificationActionConfig(f.command, store);
  const menu = controlFor(f.replies[0]!, 'select');
  assert.equal(menu.min_values, 0); assert.equal(menu.max_values, notificationActionsFor('management').length);
  assert.deepEqual(menu.options?.map((option) => option.value), notificationActionsFor('management'));
  assert.ok(menu.options?.every((option) => option.default && /\p{Script=Han}/u.test(option.label)));
  assert.deepEqual(f.replies[0]?.allowedMentions, { parse: [] });
  assert.equal(f.clicks().accepted, 1); assert.equal(f.clicks().rejected, 5);
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
  assert.match(f.output(), /已儲存管理通知項目/);
  assert.equal(f.state.memberFetches, 2);
}));

test('clear and empty multiselect both save no notifications; selecting all restores the catalog', withStore(async (store) => {
  for (const step of [{ action: 'none' } as Step, { action: 'select', values: [] } as Step]) {
    store.setNotificationActions(id.guild, 'subarea', notificationActionsFor('subarea'));
    const f = fixture([step, { action: 'save' }]); f.state.kind = 'subarea';
    await handleNotificationActionConfig(f.command, store);
    assert.deepEqual(store.getNotificationActions(id.guild, 'subarea'), []);
    assert.match(f.output(), /全部不通知/);
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
    assert.match(f.output(), action === 'cancel' ? /關閉/ : /逾時/);
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
    assert.match(f.replies.at(-1)?.content ?? '', /逾時/);
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

test('revoked managers cannot navigate from the landing card into another settings category', withStore(async (store) => {
  const f = fixture([{ action: 'kind', values: ['subarea'], onClick: () => f.actor.permissions.remove(P.ManageGuild) }], null);
  await assert.rejects(handleNotificationActionConfig(f.command, store), /原生.*管理伺服器/);
  assert.equal(f.rendered.length, 1, 'no action settings are shown after permission is revoked');
  assert.deepEqual(store.listCases(id.guild), []);
}));

test('guild owners and native administrators may save without a ManageGuild role', withStore(async (store) => {
  for (const owner of [true, false]) {
    store.setNotificationActions(id.guild, 'management', notificationActionsFor('management'));
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
  for (const values of [[], ['management', 'subarea'], ['foreign']]) {
    const f = fixture([{ action: 'kind', values }], null);
    await assert.rejects(handleNotificationActionConfig(f.command, store), /通知類型|通知項目|請選擇/);
  }
  assert.deepEqual(store.listCases(id.guild), []);
}));
