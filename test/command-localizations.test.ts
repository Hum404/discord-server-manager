import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationCommandType, InteractionContextType, PermissionFlagsBits, Routes, type REST,
} from 'discord.js';
import { registerCommands, registerDmAppeal } from '../src/application.js';
import {
  allCommands, commands, messageCommands, MESSAGE_APP_DELETE_NAME, MESSAGE_APP_PIN_NAME,
} from '../src/commands.js';
import { MANAGEMENT_SCOPES } from '../src/domain.js';

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
  for (const node of nodes) if (node.options) validateSiblings(node.options, `${path}/${node.name}`);
}

test('both Chinese Discord locales have valid, unambiguous names throughout every slash command tree', () => {
  validateSiblings(definitions());
});

test('the screenshot child-area commands and notification settings display recognizable Chinese names', () => {
  const nodes = definitions();
  const examples: Array<[string[], string, string]> = [
    [['subarea'], '子区', '子區'],
    [['subarea', 'delegate'], '设置协管', '設定協管'],
    [['subarea', 'delegate', 'user'], '成员', '成員'],
    [['subarea', 'mute'], '禁言', '禁言'],
    [['config'], '设置', '設定'],
    [['config', 'subarea-notices'], '子区通知', '子區通知'],
    [['config', 'subarea-notices', 'enabled'], '启用', '啟用'],
  ];
  for (const [path, cn, tw] of examples) {
    const node = at(nodes, ...path);
    assert.equal(node.name_localizations?.['zh-CN'], cn);
    assert.equal(node.name_localizations?.['zh-TW'], tw);
    assert.equal(node.name, path.at(-1), 'Discord continues returning the stable canonical routing name');
  }
});

test('choice labels are localized while persisted permission, subarea and appeal values stay canonical', () => {
  const nodes = definitions();
  function checkChoices(entries: Node[]) {
    for (const node of entries) {
      for (const choice of node.choices ?? []) for (const locale of locales) {
        const name = choice.name_localizations?.[locale];
        assert.ok(name && /\p{Script=Han}/u.test(name), `${node.name}/${choice.value} lacks a Chinese choice label`);
        assert.ok([...name].length <= 100);
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
  assert.equal(body.length, allCommands.length, 'translations do not register duplicate commands');
  assert.deepEqual(body.map((node) => node.name), allCommands.map((command) => command.name));
  assert.equal(at(body, 'subarea', 'delegate', 'user').name_localizations?.['zh-CN'], '成员');
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

test('the DM appeal entry preserves localized names and canonical case fields without mutating guild registration', async () => {
  const original = at(definitions(), 'appeal');
  const snapshot = structuredClone(original);
  const calls: Array<{ route: string; body: unknown }> = [];
  const rest: Pick<REST, 'post'> = { post: async (route, options) => { calls.push({ route, body: options?.body }); return {}; } };
  await registerDmAppeal(rest, appId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.route, Routes.applicationCommands(appId));
  const body = calls[0]?.body as Node;
  assert.equal(body.name, 'appeal');
  assert.ok(body.name_localizations?.['zh-CN']);
  assert.ok(body.name_localizations?.['zh-TW']);
  assert.equal(at([body], 'appeal', 'submit', 'case').name, 'case');
  assert.deepEqual(body.contexts, [InteractionContextType.BotDM]);
  assert.deepEqual(at(definitions(), 'appeal'), snapshot);
});
