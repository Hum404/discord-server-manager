import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationCommandType, InteractionContextType, PermissionFlagsBits, Routes, type REST,
} from 'discord.js';
import { registerCommands, registerDmAppeal } from '../src/application.js';
import {
  allCommands, commands, messageCommands, simplifiedCommands, MESSAGE_APP_DELETE_NAME, MESSAGE_APP_PIN_NAME,
} from '../src/commands.js';
import { MANAGEMENT_SCOPES } from '../src/domain.js';
import { canonicalCommandName } from '../src/command-localizations.js';

type Choice = { name: string; value: string | number; name_localizations?: Record<string, string | null> | null };
type Node = {
  name: string; type?: number; name_localizations?: Record<string, string | null> | null;
  options?: Node[]; choices?: Choice[]; contexts?: number[];
  default_member_permissions?: string | null;
};
const locales = ['zh-CN', 'zh-TW'] as const;
const appId = '930000000000000001';
const guildId = '930000000000000002';
const definitions = (): Node[] => commands.map((command) => command.toJSON() as unknown as Node);

function find(nodes: Node[], name: string): Node {
  const found = nodes.find((node) => node.name === name);
  assert.ok(found, `Missing canonical command or option ${name}`);
  return found;
}

function at(nodes: Node[], ...path: string[]): Node {
  let current = find(nodes, path[0]!);
  for (const part of path.slice(1)) current = find(current.options ?? [], part);
  return current;
}

function validateSiblings(nodes: Node[], path = ''): void {
  for (const locale of locales) {
    const seen = new Set<string>();
    for (const node of nodes) {
      const name = node.name_localizations?.[locale];
      assert.equal(typeof name, 'string', `${path}/${node.name} lacks ${locale} display name`);
      assert.ok(name && /\p{Script=Han}/u.test(name), `${path}/${node.name} falls back to an English display name`);
      assert.ok([...name].length >= 1 && [...name].length <= 32, `${path}/${node.name} has an invalid name length`);
      assert.match(name, /^[-_\p{L}\p{N}]+$/u, `${path}/${node.name} has an invalid slash-name character`);
      assert.ok(!seen.has(name), `${path} has duplicate ${locale} names: ${name}`);
      seen.add(name);
    }
  }
  for (const node of nodes) {
    assert.equal(node.name_localizations?.['zh-CN'], node.name_localizations?.['zh-TW'],
      `${path}/${node.name} must use the same entry name in both Chinese clients`);
    if (node.options) validateSiblings(node.options, `${path}/${node.name}`);
  }
}

test('both Chinese Discord locales use identical valid Traditional names throughout every slash command tree', () => {
  validateSiblings(definitions());
});

test('the screenshot child-area commands and notification settings display consistent Traditional names', () => {
  const nodes = definitions();
  const examples: Array<[string[], string]> = [
    [['subarea'], '子區'],
    [['subarea', 'create'], '建立'],
    [['subarea', 'announce'], '全體通知'],
    [['subarea', 'delegates'], '協管名單'],
    [['subarea', 'delegate'], '設定協管'],
    [['subarea', 'delegate', 'user'], '成員'],
    [['subarea', 'delete-message'], '刪除訊息'],
    [['subarea', 'mute'], '禁言'],
    [['config'], '設定'],
    [['config', 'subarea-notices'], '子區通知'],
    [['config', 'subarea-notices', 'enabled'], '啟用'],
  ];
  for (const [path, name] of examples) {
    const node = at(nodes, ...path);
    for (const locale of locales) assert.equal(node.name_localizations?.[locale], name);
    assert.equal(node.name, path.at(-1), 'Discord continues returning the stable canonical routing name');
  }
});

test('choice labels are localized while persisted permission, subarea and appeal values stay canonical', () => {
  const nodes = definitions();
  function checkChoices(entries: Node[]) {
    for (const node of entries) {
      for (const choice of node.choices ?? []) {
        for (const locale of locales) {
          const name = choice.name_localizations?.[locale];
          assert.ok(name && /\p{Script=Han}/u.test(name), `${node.name}/${choice.value} lacks a Chinese choice label`);
          assert.ok([...name].length <= 100);
        }
        assert.equal(choice.name_localizations?.['zh-CN'], choice.name_localizations?.['zh-TW'],
          `${node.name}/${choice.value} must use the same Traditional Chinese choice label`);
      }
      if (node.options) checkChoices(node.options);
    }
  }
  checkChoices(nodes);
  assert.deepEqual(at(nodes, 'access', 'grant', 'scope').choices?.map((choice) => choice.value), ['all', ...MANAGEMENT_SCOPES]);
  assert.deepEqual(at(nodes, 'subarea', 'create', 'type').choices?.map((choice) => choice.value), ['text', 'thread', 'forum']);
  assert.deepEqual(at(nodes, 'appeal', 'review', 'result').choices?.map((choice) => choice.value), ['accepted', 'rejected']);
  assert.deepEqual(at(nodes, 'subarea', 'announce', 'audience').choices?.map((choice) => choice.value), ['everyone', 'here']);
});

test('Simplified search entries coexist with Traditional commands without localized name collisions', () => {
  const aliases = simplifiedCommands.map((command) => command.toJSON() as unknown as Node);
  assert.ok(aliases.length > 0);
  const nodes = definitions();
  validateSiblings([...nodes, ...aliases]);
  assert.ok(nodes.length + aliases.length <= 100, 'registered slash commands remain below Discord limits');
  assert.equal(find(aliases, '子区').name_localizations?.['zh-CN'], '子区');
  assert.equal(at(aliases, '子区', 'delegate').name_localizations?.['zh-TW'], '设置协管');
  assert.equal(at(aliases, '子区', 'delegate', 'user').name_localizations?.['zh-CN'], '成员');
  assert.equal(canonicalCommandName('子区'), 'subarea');
  assert.equal(canonicalCommandName('设置'), 'config');
  assert.equal(canonicalCommandName('申诉'), 'appeal');
  assert.equal(aliases.some((alias) => ['警告', '禁言', '踢出'].includes(alias.name)), false,
    'identical Simplified and Traditional roots reuse their existing entry');
  const keys = allCommands.map((command) => {
    const definition = command.toJSON();
    return `${definition.type ?? ApplicationCommandType.ChatInput}:${definition.name}`;
  });
  assert.equal(new Set(keys).size, keys.length);
});

test('Simplified search aliases preserve every permission, argument constraint and canonical choice value', () => {
  function functional(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(functional);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'name_localizations' && key !== 'description_localizations')
      .map(([key, entry]) => [key, functional(entry)]));
    return value;
  }
  const primary = definitions();
  for (const alias of simplifiedCommands) {
    const definition = alias.toJSON() as unknown as Node;
    const canonical = canonicalCommandName(definition.name);
    assert.notEqual(canonical, definition.name, 'only explicit aliases enter the compatibility set');
    assert.deepEqual(functional({ ...definition, name: canonical }), functional(find(primary, canonical)),
      `${definition.name} must keep the original permission and argument schema`);
  }
});

test('message APP menus retain their command identity and receive both Chinese display names', () => {
  const menus = messageCommands.map((command) => command.toJSON());
  assert.deepEqual(menus.map((menu) => menu.name), [MESSAGE_APP_PIN_NAME, MESSAGE_APP_DELETE_NAME]);
  for (const menu of menus) {
    assert.equal(menu.type, ApplicationCommandType.Message);
    for (const locale of locales) {
      const name = menu.name_localizations?.[locale];
      assert.ok(name && /\p{Script=Han}/u.test(name));
      assert.ok([...name].length <= 32);
    }
    assert.equal(menu.name_localizations?.['zh-CN'], menu.name_localizations?.['zh-TW']);
    assert.equal(menu.name_localizations?.['zh-CN'], menu.name, 'APP labels stay in the existing Traditional Chinese form');
    assert.equal(Object.hasOwn(menu, 'options'), false);
    assert.equal(Object.hasOwn(menu, 'description'), false);
  }
});

test('global registration sends translated display names with the original routing names and native permissions', async () => {
  const calls: Array<{ route: string; body: unknown }> = [];
  const rest: Pick<REST, 'put'> = { put: async (route, options) => { calls.push({ route, body: options?.body }); return []; } };
  const registered = await registerCommands(rest, appId);
  assert.equal(registered, allCommands.length);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.route, Routes.applicationCommands(appId));
  const body = calls[0]?.body as Node[];
  assert.equal(body.length, allCommands.length, 'every primary and search entry is registered once');
  assert.deepEqual(body.map((node) => node.name), allCommands.map((command) => command.name));
  assert.equal(at(body, 'subarea', 'delegate', 'user').name_localizations?.['zh-CN'], '成員');
  assert.equal(at(body, 'config').default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
  assert.equal(at(body, 'warn').default_member_permissions, null, 'localized moderation remains available to delegated users');
  assert.deepEqual(at(body, 'appeal').contexts, [InteractionContextType.Guild, InteractionContextType.BotDM]);
});

test('guild registration preserves nested translations when stripping unsupported installation fields', async () => {
  const calls: Array<{ route: string; body: unknown }> = [];
  const rest: Pick<REST, 'put'> = { put: async (route, options) => { calls.push({ route, body: options?.body }); return []; } };
  await registerCommands(rest, appId, guildId);
  assert.equal(calls[0]?.route, Routes.applicationGuildCommands(appId, guildId));
  const body = calls[0]?.body as Node[];
  assert.equal(body.length, allCommands.length);
  assert.equal(at(body, 'subarea', 'delegate').name_localizations?.['zh-TW'], '設定協管');
  assert.equal(at(body, 'config', 'subarea-notices', 'enabled').name, 'enabled');
  for (const node of body) {
    assert.equal(Object.hasOwn(node, 'contexts'), false);
    assert.equal(Object.hasOwn(node, 'integration_types'), false);
  }
});

test('DM appeals preserve both search entries and canonical case fields without mutating guild registration', async () => {
  const original = at(definitions(), 'appeal');
  const snapshot = structuredClone(original);
  const calls: Array<{ route: string; body: unknown }> = [];
  const rest: Pick<REST, 'post'> = { post: async (route, options) => { calls.push({ route, body: options?.body }); return {}; } };
  await registerDmAppeal(rest, appId);
  assert.deepEqual(calls.map((call) => (call.body as Node).name), ['appeal', '申诉']);
  for (const call of calls) {
    assert.equal(call.route, Routes.applicationCommands(appId));
    const body = call.body as Node;
    assert.equal(canonicalCommandName(body.name), 'appeal');
    assert.ok(body.name_localizations?.['zh-CN']);
    assert.ok(body.name_localizations?.['zh-TW']);
    assert.equal(at([body], body.name, 'submit', 'case').name, 'case');
    assert.deepEqual(body.contexts, [InteractionContextType.BotDM]);
  }
  assert.deepEqual(at(definitions(), 'appeal'), snapshot);
});
