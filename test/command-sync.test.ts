import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationCommandType, ApplicationIntegrationType, InteractionContextType, PermissionFlagsBits, Routes, type REST } from 'discord.js';
import {
  listBotGuilds, readCommandState, syncCommandState,
  type CommandState, type SavedCommand,
} from '../src/command-sync.js';
import { allCommands, messageCommands, MESSAGE_APP_PIN_NAME, MESSAGE_APP_DELETE_NAME } from '../src/commands.js';
import { ConfigError } from '../src/config.js';

const appId = '123456789012345678';
const guildId = '234567890123456789';
const otherGuildId = '345678901234567890';
const globalRoute = Routes.applicationCommands(appId);
const guildRoute = Routes.applicationGuildCommands(appId, guildId);
const otherGuildRoute = Routes.applicationGuildCommands(appId, otherGuildId);
const idAt = (index: number) => String(400_000_000_000_000_000n + BigInt(index));
const command = (index: number, name: string, type = 1): SavedCommand => ({ id: idAt(index), name, type });

function apiCommand(definition: object, index: number, guildOnly = false): SavedCommand {
  const data = structuredClone(definition) as Record<string, unknown>;
  if (guildOnly) {
    delete data.contexts;
    delete data.integration_types;
  }
  return {
    ...data,
    id: idAt(index),
    application_id: appId,
    version: idAt(1_000 + index),
    ...(guildOnly ? { guild_id: guildId } : {}),
    name: String(data.name),
    type: typeof data.type === 'number' ? data.type : 1,
  };
}

const currentCommands = (guildOnly = false): SavedCommand[] => allCommands.map((definition, index) =>
  apiCommand(definition.toJSON(), index, guildOnly));

function namedCommand(entries: SavedCommand[], name: string): SavedCommand {
  const entry = entries.find((candidate) => candidate.name === name);
  assert.ok(entry, `Missing command fixture ${name}`);
  return entry;
}

function namedOption(parent: Record<string, unknown>, name: string): Record<string, unknown> {
  assert.ok(Array.isArray(parent.options));
  const option = (parent.options as Record<string, unknown>[]).find((candidate) => candidate.name === name);
  assert.ok(option, `Missing option fixture ${name}`);
  return option;
}

function mockState(initial: CommandState) {
  let global = initial.global.map((entry) => ({ ...entry }));
  let guild = initial.guild.map((entry) => ({ ...entry }));
  const calls: { method: string; route: string; body?: unknown }[] = [];
  const rest: Pick<REST, 'get' | 'put' | 'delete'> = {
    get: async (route) => {
      calls.push({ method: 'GET', route });
      if (route === globalRoute) return global;
      if (route === guildRoute) return guild;
      throw new Error('Unexpected scope');
    },
    put: async (route, options) => {
      calls.push({ method: 'PUT', route, body: options?.body });
      assert.ok(Array.isArray(options?.body));
      const updated = options.body.map((entry: Record<string, unknown>, index: number) =>
        apiCommand(entry, index, route === guildRoute));
      if (route === globalRoute) global = updated;
      else if (route === guildRoute) guild = updated;
      else throw new Error('Unexpected scope');
      return updated;
    },
    delete: async (route) => {
      calls.push({ method: 'DELETE', route });
      const removed = global.find((entry) => Routes.applicationCommand(appId, entry.id) === route);
      assert.ok(removed, 'Delete must target an existing saved global command');
      global = global.filter((entry) => entry.id !== removed.id);
      return undefined;
    },
  };
  return { rest, calls, snapshot: () => ({ global, guild }) };
}

test('global sync installs current definitions before clearing only the selected guild overrides', async () => {
  const saved = {
    global: [command(100, 'retired'), command(101, 'help')],
    guild: [command(200, 'guild-old'), command(201, 'help', 2)],
  };
  const { rest, calls, snapshot } = mockState(saved);
  assert.deepEqual(await syncCommandState(rest, appId, guildId, saved, false), {
    registered: allCommands.length, removedGuild: 2, removedGlobal: 1,
  });
  assert.deepEqual(calls.map(({ method, route }) => ({ method, route })), [
    { method: 'PUT', route: globalRoute },
    { method: 'PUT', route: guildRoute },
    { method: 'GET', route: globalRoute },
    { method: 'GET', route: guildRoute },
  ]);
  assert.deepEqual(calls[1]?.body, []);
  assert.deepEqual(snapshot().global.map((entry) => entry.name), allCommands.map((entry) => entry.name));
  assert.deepEqual(snapshot().guild, []);
  assert.equal(calls.some((entry) => entry.route === otherGuildRoute), false);
});

test('global sync does not clear an already empty selected guild', async () => {
  const state: CommandState = { global: [], guild: [] };
  const { rest, calls } = mockState(state);
  await syncCommandState(rest, appId, guildId, state, false);
  assert.deepEqual(calls.filter((entry) => entry.method === 'PUT').map((entry) => entry.route), [globalRoute]);
});

test('guild-only sync restores its full command set and prunes only unsupported global identities', async () => {
  const saved: CommandState = {
    global: [command(100, 'help'), command(101, 'help', 2), command(102, 'warn', 3), command(103, 'retired')],
    guild: [command(200, 'guild-old'), command(201, 'ping')],
  };
  const { rest, calls, snapshot } = mockState(saved);
  assert.deepEqual(await syncCommandState(rest, appId, guildId, saved, true), {
    registered: allCommands.length, removedGuild: 1, removedGlobal: 3,
  });
  assert.deepEqual(calls.filter((entry) => entry.method === 'PUT').map((entry) => entry.route), [guildRoute]);
  assert.equal(calls[0]?.route, guildRoute);
  assert.deepEqual(calls.filter((entry) => entry.method === 'DELETE').map((entry) => entry.route),
    saved.global.slice(1).map((entry) => Routes.applicationCommand(appId, entry.id)));
  assert.deepEqual(snapshot().global, [saved.global[0]]);
  assert.deepEqual(snapshot().guild.map((entry) => entry.name), allCommands.map((entry) => entry.name));
  assert.equal(calls.some((entry) => entry.route.includes(otherGuildId)), false);
});

test('guild sync preserves supported message identities and prunes same-name commands of another type', async () => {
  const saved: CommandState = {
    global: [command(100, MESSAGE_APP_PIN_NAME, ApplicationCommandType.Message),
      command(101, MESSAGE_APP_PIN_NAME, ApplicationCommandType.ChatInput),
      command(102, MESSAGE_APP_DELETE_NAME, ApplicationCommandType.Message),
      command(103, MESSAGE_APP_DELETE_NAME, ApplicationCommandType.User),
      command(104, '舊訊息工具', ApplicationCommandType.Message)],
    guild: [],
  };
  const { rest, calls, snapshot } = mockState(saved);
  assert.deepEqual(await syncCommandState(rest, appId, guildId, saved, true), {
    registered: allCommands.length, removedGuild: 0, removedGlobal: 3,
  });
  assert.deepEqual(calls.filter((entry) => entry.method === 'DELETE').map((entry) => entry.route),
    [saved.global[1], saved.global[3], saved.global[4]].map((entry) => Routes.applicationCommand(appId, entry!.id)));
  assert.deepEqual(snapshot().global.map((entry) => [entry.type, entry.name]),
    [[ApplicationCommandType.Message, MESSAGE_APP_PIN_NAME], [ApplicationCommandType.Message, MESSAGE_APP_DELETE_NAME]]);
  const menus = snapshot().guild.filter((entry) => entry.type === ApplicationCommandType.Message);
  assert.deepEqual(menus.map((entry) => entry.name), messageCommands.map((entry) => entry.name));
});

test('verification rejects current message APP actions returned with a stale command type', async () => {
  for (const guildOnly of [false, true]) {
    const saved: CommandState = { global: [], guild: [] };
    const { rest } = mockState(saved);
    const active = currentCommands(guildOnly);
    namedCommand(active, MESSAGE_APP_DELETE_NAME).type = ApplicationCommandType.User;
    rest.get = async (route) => route === globalRoute ? guildOnly ? [] : active : guildOnly ? active : [];
    await assert.rejects(syncCommandState(rest, appId, guildId, saved, guildOnly), ConfigError);
  }
});

test('global sync accepts message API omitted descriptions and options but requires guild invocation contexts', async () => {
  for (const wrongContext of [false, true]) {
    const saved: CommandState = { global: [], guild: [] };
    const { rest } = mockState(saved);
    const active = currentCommands();
    for (const entry of active.filter((command) => command.type === ApplicationCommandType.Message)) {
      delete entry.description;
      delete entry.options;
      if (wrongContext) entry.contexts = [InteractionContextType.BotDM];
    }
    rest.get = async (route) => route === globalRoute ? active : [];
    const result = syncCommandState(rest, appId, guildId, saved, false);
    if (wrongContext) await assert.rejects(result, ConfigError);
    else assert.equal((await result).registered, allCommands.length);
  }
});

test('global verification requires guild-install message actions and accepts the API guild-install default', async () => {
  for (const installs of [undefined, [ApplicationIntegrationType.UserInstall],
    [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall]]) {
    const saved: CommandState = { global: [], guild: [] };
    const { rest } = mockState(saved);
    const active = currentCommands();
    const pin = namedCommand(active, MESSAGE_APP_PIN_NAME);
    if (installs === undefined) delete pin.integration_types;
    else pin.integration_types = installs;
    rest.get = async (route) => route === globalRoute ? active : [];
    const result = syncCommandState(rest, appId, guildId, saved, false);
    if (installs === undefined) assert.equal((await result).registered, allCommands.length);
    else await assert.rejects(result, ConfigError);
  }
});

test('an install failure propagates without clearing legacy command sources', async () => {
  const initial: CommandState = { global: [command(100, 'retired')], guild: [command(200, 'old')] };
  const error = new Error('synthetic REST failure');
  for (const guildOnly of [false, true]) {
    const { rest, calls } = mockState(initial);
    rest.put = async () => { throw error; };
    await assert.rejects(syncCommandState(rest, appId, guildId, initial, guildOnly), (actual) => actual === error);
    assert.deepEqual(calls, []);
  }
});

test('verification rejects a stale source reintroduced by another process', async () => {
  for (const guildOnly of [false, true]) {
    const initial: CommandState = { global: [], guild: [] };
    const { rest } = mockState(initial);
    rest.get = async (route) => route === globalRoute
      ? [...currentCommands(), command(500, 'reintroduced-old-command')]
      : guildOnly ? currentCommands(true) : [];
    await assert.rejects(syncCommandState(rest, appId, guildId, initial, guildOnly), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /舊程式/);
      return true;
    });
  }
});

test('verification rejects a missing current command or uncleared guild source', async () => {
  for (const failure of ['missing-global', 'uncleared-guild', 'missing-guild']) {
    const initial: CommandState = { global: [], guild: [] };
    const { rest } = mockState(initial);
    rest.get = async (route) => {
      if (route === globalRoute) return failure === 'missing-global' ? currentCommands().slice(1) : currentCommands();
      return failure === 'missing-guild' ? currentCommands(true).slice(1)
        : failure === 'uncleared-guild' ? [command(500, 'old-guild')] : [];
    };
    await assert.rejects(syncCommandState(rest, appId, guildId, initial, failure === 'missing-guild'), ConfigError);
  }
});

test('verification rejects same-name commands with stale descriptions or argument schemas in either active scope', async () => {
  const changes: ((entries: SavedCommand[]) => void)[] = [
    (entries) => { namedCommand(entries, 'help').description = 'Retired description'; },
    (entries) => { namedOption(namedCommand(entries, 'warn'), 'user').required = false; },
    (entries) => { namedOption(namedCommand(entries, 'timeout'), 'minutes').max_value = 10; },
    (entries) => { namedOption(namedCommand(entries, 'unban'), 'user_id').min_length = 1; },
    (entries) => {
      namedOption(namedOption(namedCommand(entries, 'config'), 'welcome-message'), 'message').max_length = 512;
    },
    (entries) => {
      namedOption(namedOption(namedCommand(entries, 'config'), 'welcome'), 'channel').channel_types = [2];
    },
    (entries) => {
      namedOption(namedCommand(entries, 'ban'), 'delete_days').choices = [{ name: 'Old choice', value: 0 }];
    },
    (entries) => { namedOption(namedCommand(entries, 'warn'), 'user').name = 'old-user'; },
  ];
  for (const guildOnly of [false, true]) {
    for (const change of changes) {
      const initial: CommandState = { global: [], guild: [] };
      const { rest } = mockState(initial);
      const active = currentCommands(guildOnly);
      change(active);
      rest.get = async (route) => route === globalRoute ? guildOnly ? [] : active : guildOnly ? active : [];
      await assert.rejects(syncCommandState(rest, appId, guildId, initial, guildOnly), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /舊程式/);
        return true;
      });
    }
  }
});

test('verification rejects same-name commands with stale management or public default permissions', async () => {
  for (const guildOnly of [false, true]) {
    for (const name of ['warn', 'help']) {
      const initial: CommandState = { global: [], guild: [] };
      const { rest } = mockState(initial);
      const active = currentCommands(guildOnly);
      namedCommand(active, name).default_member_permissions = name === 'warn'
        ? '0' : PermissionFlagsBits.Administrator.toString();
      rest.get = async (route) => route === globalRoute ? guildOnly ? [] : active : guildOnly ? active : [];
      await assert.rejects(syncCommandState(rest, appId, guildId, initial, guildOnly), ConfigError);
    }
  }
});

test('global verification rejects a same-name definition available in the wrong interaction context', async () => {
  const initial: CommandState = { global: [], guild: [] };
  const { rest } = mockState(initial);
  const active = currentCommands();
  namedCommand(active, 'help').contexts = [InteractionContextType.BotDM];
  rest.get = async (route) => route === globalRoute ? active : [];
  await assert.rejects(syncCommandState(rest, appId, guildId, initial, false), ConfigError);
});

test('API metadata and explicit optional defaults do not falsely fail functional verification', async () => {
  function addDefaults(parent: Record<string, unknown>): void {
    if (parent.default_member_permissions === undefined) parent.default_member_permissions = null;
    if (parent.options === undefined) parent.options = [];
    assert.ok(Array.isArray(parent.options));
    for (const option of parent.options as Record<string, unknown>[]) {
      if (option.type === 1 || option.type === 2) {
        addDefaults(option);
      } else if (option.required === undefined) {
        option.required = false;
      }
      if ([3, 4, 10].includes(Number(option.type))) {
        if (option.autocomplete === undefined) option.autocomplete = false;
        if (option.choices === undefined) option.choices = [];
      }
      if (option.type === 3) {
        if (option.min_length === undefined) option.min_length = 0;
        if (option.max_length === undefined) option.max_length = 6000;
      }
      if (option.type === 4 || option.type === 10) {
        if (option.min_value === undefined) option.min_value = null;
        if (option.max_value === undefined) option.max_value = null;
      }
      if (Array.isArray(option.channel_types)) option.channel_types.reverse();
    }
  }
  for (const guildOnly of [false, true]) {
    const initial: CommandState = { global: [], guild: [] };
    const { rest } = mockState(initial);
    const active = currentCommands(guildOnly);
    for (const entry of active) {
      addDefaults(entry);
      entry.id = idAt(2_000 + active.indexOf(entry));
      entry.version = idAt(3_000 + active.indexOf(entry));
      entry.nsfw = false;
      entry.dm_permission = false;
      if (guildOnly) entry.contexts = [InteractionContextType.BotDM];
    }
    rest.get = async (route) => route === globalRoute ? guildOnly ? [] : active : guildOnly ? active : [];
    assert.deepEqual(await syncCommandState(rest, appId, guildId, initial, guildOnly), {
      registered: allCommands.length, removedGuild: 0, removedGlobal: 0,
    });
  }
});

test('post-mutation response validation uses a safe verification error while REST failures propagate', async () => {
  const initial: CommandState = { global: [], guild: [] };
  const malformed = mockState(initial);
  malformed.rest.get = async () => ({ unexpected: 'sensitive-response-value' });
  await assert.rejects(syncCommandState(malformed.rest, appId, guildId, initial, false), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /舊程式/);
    assert.equal(error.message.includes('sensitive-response-value'), false);
    return true;
  });
  const failed = mockState(initial);
  const networkError = new Error('synthetic verification REST failure');
  failed.rest.get = async () => { throw networkError; };
  await assert.rejects(syncCommandState(failed.rest, appId, guildId, initial, false), (error) => error === networkError);
});

test('invalid target IDs fail before any REST reads or mutations', async () => {
  let calls = 0;
  const rest: Pick<REST, 'get' | 'put' | 'delete'> = {
    get: async () => { calls += 1; return []; },
    put: async () => { calls += 1; return []; },
    delete: async () => { calls += 1; return undefined; },
  };
  for (const invalid of ['', 'invalid-private-value', '1234567890123456', '123456789012345678901']) {
    for (const [application, guild] of [[invalid, guildId], [appId, invalid]]) {
      await assert.rejects(readCommandState(rest, application!, guild!), ConfigError);
      await assert.rejects(syncCommandState(rest, application!, guild!, { global: [], guild: [] }, false), ConfigError);
    }
  }
  assert.equal(calls, 0);
});

test('command snapshots retain all API fields and default an omitted type to slash', async () => {
  const raw = { id: idAt(1), name: 'old', description: 'Original description', options: [{ type: 3 }], version: idAt(2) };
  const rest: Pick<REST, 'get'> = { get: async (route) => route === globalRoute ? [raw] : [] };
  assert.deepEqual(await readCommandState(rest, appId, guildId), { global: [{ ...raw, type: 1 }], guild: [] });
  assert.equal(Object.hasOwn(raw, 'type'), false);
});

test('command reads explicitly request all localizations in both scopes and retain their metadata', async () => {
  const raw = { ...command(1, 'help'), name_localizations: { 'zh-TW': '說明', 'zh-CN': '帮助' },
    name_localized: '說明', description_localizations: { 'zh-TW': '指令說明' } };
  const routes: string[] = [];
  const rest: Pick<REST, 'get'> = { get: async (route, options) => {
    routes.push(route);
    assert.ok(options?.query instanceof URLSearchParams);
    assert.equal(options.query.get('with_localizations'), 'true');
    return route === globalRoute ? [raw] : [];
  } };
  assert.deepEqual(await readCommandState(rest, appId, guildId), { global: [raw], guild: [] });
  assert.deepEqual(routes.sort(), [globalRoute, guildRoute].sort());
});

test('verification rejects missing or stale Chinese labels throughout registered command schemas', async () => {
  const changes: Array<(entries: SavedCommand[]) => void> = [
    (entries) => { delete namedCommand(entries, 'subarea').name_localizations; },
    (entries) => { namedCommand(entries, 'help').description_localizations = { 'zh-CN': '过期的说明' }; },
    (entries) => { delete namedOption(namedCommand(entries, 'subarea'), 'delegate').name_localizations; },
    (entries) => { delete namedOption(namedOption(namedCommand(entries, 'subarea'), 'delegate'), 'user').name_localizations; },
    (entries) => { namedOption(namedOption(namedCommand(entries, 'subarea'), 'mute'), 'reason')
      .description_localizations = { 'zh-CN': '过期的原因说明' }; },
    (entries) => {
      const choices = namedOption(namedOption(namedCommand(entries, 'subarea'), 'create'), 'type').choices;
      assert.ok(Array.isArray(choices));
      (choices[0] as Record<string, unknown>).name_localizations = { 'zh-CN': '过期的选项名称' };
    },
    (entries) => { delete namedCommand(entries, MESSAGE_APP_DELETE_NAME).name_localizations; },
  ];
  for (const guildOnly of [false, true]) {
    for (const change of changes) {
      const initial: CommandState = { global: [], guild: [] };
      const { rest } = mockState(initial);
      const active = currentCommands(guildOnly);
      change(active);
      rest.get = async (route) => route === globalRoute ? guildOnly ? [] : active : guildOnly ? active : [];
      await assert.rejects(syncCommandState(rest, appId, guildId, initial, guildOnly), ConfigError);
    }
  }
});

test('localization map key order and API selected display labels do not change command identity', async () => {
  function reorder(node: Record<string, unknown>): void {
    for (const field of ['name_localizations', 'description_localizations']) {
      const value = node[field];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        node[field] = Object.fromEntries(Object.entries(value).reverse());
      } else if (value === undefined) node[field] = null;
    }
    node.name_localized = '仅用于当前界面的名字';
    node.description_localized = '僅用於目前介面的說明';
    if (Array.isArray(node.options)) for (const option of node.options) reorder(option as Record<string, unknown>);
    if (Array.isArray(node.choices)) for (const choice of node.choices) reorder(choice as Record<string, unknown>);
  }
  for (const guildOnly of [false, true]) {
    const initial: CommandState = { global: currentCommands(), guild: [] };
    for (const entry of initial.global) reorder(entry);
    const { rest, calls } = mockState(initial);
    const active = currentCommands(guildOnly);
    for (const entry of active) reorder(entry);
    rest.get = async (route) => route === globalRoute ? guildOnly ? initial.global : active : guildOnly ? active : [];
    assert.equal((await syncCommandState(rest, appId, guildId, initial, guildOnly)).registered, allCommands.length);
    assert.equal(calls.some((entry) => entry.method === 'DELETE'), false,
      'localized display labels must not be treated as stale canonical command names');
  }
});

test('malformed returned localization maps cannot pass schema verification', async () => {
  for (const invalid of [[], 'invalid', 3, { 'zh-CN': null }, { 'zh-TW': 42 }]) {
    const initial: CommandState = { global: [], guild: [] };
    const { rest } = mockState(initial);
    const active = currentCommands();
    namedCommand(active, 'subarea').name_localizations = invalid;
    rest.get = async (route) => route === globalRoute ? active : [];
    await assert.rejects(syncCommandState(rest, appId, guildId, initial, false), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /舊程式/);
      return true;
    });
  }
});

test('malformed or duplicate command snapshots are rejected before mutations', async () => {
  const invalidLists: unknown[] = [
    null, {}, [null], [{ id: idAt(1), name: '' }], [{ id: 'invalid', name: 'old' }],
    [{ id: idAt(1), name: 'old', type: '1' }], [{ id: idAt(1), name: 'old', type: 0 }],
    [command(1, 'same'), command(2, 'same')], [command(1, 'one'), command(1, 'two')],
  ];
  let mutations = 0;
  for (const invalid of invalidLists) {
    const rest: Pick<REST, 'get' | 'put' | 'delete'> = {
      get: async () => invalid,
      put: async () => { mutations += 1; return []; },
      delete: async () => { mutations += 1; return undefined; },
    };
    await assert.rejects(readCommandState(rest, appId, guildId), ConfigError);
    await assert.rejects(syncCommandState(rest, appId, guildId, { global: invalid, guild: [] } as CommandState, false), ConfigError);
  }
  assert.equal(mutations, 0);
});

test('guild listing paginates after the largest validated ID and retains only ID/name', async () => {
  const first = Array.from({ length: 200 }, (_value, index) => ({ id: idAt(index), name: `Guild ${index}`, permissions: '8' })).reverse();
  const second = [{ id: idAt(200), name: 'Final guild' }];
  const queries: URLSearchParams[] = [];
  const rest: Pick<REST, 'get'> = {
    get: async (route, options) => {
      assert.equal(route, Routes.userGuilds());
      assert.ok(options?.query instanceof URLSearchParams);
      queries.push(new URLSearchParams(options.query));
      return queries.length === 1 ? first : second;
    },
  };
  const guilds = await listBotGuilds(rest);
  assert.equal(guilds.length, 201);
  assert.deepEqual(guilds[0], { id: first[0]!.id, name: first[0]!.name });
  assert.equal(queries[0]?.get('limit'), '200');
  assert.equal(queries[0]?.has('after'), false);
  assert.equal(queries[1]?.get('after'), idAt(199));
});

test('guild listing rejects repeated pages and never advances into an endless loop', async () => {
  const page = Array.from({ length: 200 }, (_value, index) => ({ id: idAt(index), name: `Guild ${index}` }));
  let reads = 0;
  const rest: Pick<REST, 'get'> = { get: async () => { reads += 1; return page; } };
  await assert.rejects(listBotGuilds(rest), ConfigError);
  assert.equal(reads, 2);
});

test('guild listing rejects malformed values and accepts an empty membership list', async () => {
  for (const value of [null, {}, [null], [{ id: 'invalid-sensitive-id', name: 'Guild' }], [{ id: idAt(1), name: '' }]]) {
    await assert.rejects(listBotGuilds({ get: async () => value }), ConfigError);
  }
  assert.deepEqual(await listBotGuilds({ get: async () => [] }), []);
});
