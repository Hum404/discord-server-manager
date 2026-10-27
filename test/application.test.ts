import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InteractionContextType, Routes, type REST } from 'discord.js';
import { registerCommands, registerDmAppeal, resolveApplication } from '../src/application.js';
import { commands } from '../src/commands.js';
import { ConfigError, parseConfig } from '../src/config.js';

const applicationId = '123456789012345678';
const guildId = '234567890123456789';

test('resolves the token application without a supplied client ID and returns only its ID', async () => {
  const routes: string[] = [];
  const rest: Pick<REST, 'get'> = {
    get: async (route) => {
      routes.push(route);
      return { id: applicationId, token: 'sensitive-response-value', name: 'Test application' };
    },
  };
  assert.deepEqual(await resolveApplication(rest), { id: applicationId });
  assert.deepEqual(routes, [Routes.oauth2CurrentApplication()]);
});

test('accepts both supported application ID length boundaries', async () => {
  for (const id of ['12345678901234567', '12345678901234567890']) {
    const rest: Pick<REST, 'get'> = { get: async () => ({ id }) };
    assert.deepEqual(await resolveApplication(rest), { id });
  }
});

test('rejects malformed Discord application responses with credential-safe configuration errors', async () => {
  const responses: unknown[] = [
    undefined,
    null,
    [],
    'sensitive-response-value',
    { token: 'sensitive-response-value' },
    { id: 123456789012345678 },
    { id: 'sensitive-response-value' },
    { id: '1234567890123456' },
    { id: '123456789012345678901' },
    { id: ` ${applicationId} ` },
  ];
  for (const response of responses) {
    await assert.rejects(
      resolveApplication({ get: async () => response }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(!error.message.includes('sensitive-response-value'));
        if (typeof response === 'object' && response !== null && 'id' in response) {
          assert.ok(!error.message.includes(String(response.id)));
        }
        return true;
      },
    );
  }
});

test('a valid but stale legacy client ID does not block token-derived registration', async () => {
  const env = { DISCORD_TOKEN: 'synthetic-token-for-offline-test' };
  const config = parseConfig({ ...env, DISCORD_CLIENT_ID: '987654321098765432' });
  assert.deepEqual(config, parseConfig(env));
  const routes: string[] = [];
  const rest: Pick<REST, 'get' | 'put'> = {
    get: async (route) => {
      routes.push(route);
      return { id: applicationId };
    },
    put: async (route) => {
      routes.push(route);
      return [];
    },
  };
  const application = await resolveApplication(rest);
  assert.equal(await registerCommands(rest, application.id, config.guildId), commands.length);
  assert.deepEqual(routes, [Routes.oauth2CurrentApplication(), Routes.applicationCommands(applicationId)]);
});

test('global registration preserves command contexts including bot-DM appeals', async () => {
  const calls: { route: string; body: unknown }[] = [];
  const rest: Pick<REST, 'put'> = {
    put: async (route, options) => {
      calls.push({ route, body: options?.body });
      return [];
    },
  };
  assert.equal(await registerCommands(rest, applicationId), commands.length);
  assert.deepEqual(calls, [{
    route: Routes.applicationCommands(applicationId),
    body: commands.map((command) => command.toJSON()),
  }]);
  const body = calls[0]?.body;
  assert.ok(Array.isArray(body));
  for (const command of body) {
    assert.deepEqual(command.contexts, command.name === 'appeal'
      ? [InteractionContextType.Guild, InteractionContextType.BotDM]
      : [InteractionContextType.Guild]);
  }
});

test('guild registration strips fields unsupported by the guild command endpoint', async () => {
  const calls: { route: string; body: unknown }[] = [];
  const rest: Pick<REST, 'put'> = {
    put: async (route, options) => {
      calls.push({ route, body: options?.body });
      return [];
    },
  };
  assert.equal(await registerCommands(rest, applicationId, guildId), commands.length);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.route, Routes.applicationGuildCommands(applicationId, guildId));
  const body = calls[0]?.body;
  assert.ok(Array.isArray(body));
  assert.deepEqual(body.map((command) => command.name), commands.map((command) => command.name));
  for (const command of body) {
    assert.equal(Object.hasOwn(command, 'contexts'), false);
    assert.equal(Object.hasOwn(command, 'integration_types'), false);
  }
});

test('invalid application or guild IDs fail before any REST mutation', async () => {
  let putCalls = 0;
  const rest: Pick<REST, 'put'> = {
    put: async () => {
      putCalls += 1;
      return [];
    },
  };
  for (const invalidId of ['', 'invalid-sensitive-id', '1234567890123456', '123456789012345678901']) {
    for (const [app, guild] of [[invalidId, guildId], [applicationId, invalidId]]) {
      await assert.rejects(
        registerCommands(rest, app!, guild),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          if (invalidId) assert.ok(!error.message.includes(invalidId));
          return true;
        },
      );
    }
  }
  assert.equal(putCalls, 0);
});

test('token-only resolution supplies the application ID used for command registration', async () => {
  const routes: string[] = [];
  const rest: Pick<REST, 'get' | 'put'> = {
    get: async (route) => {
      routes.push(route);
      return { id: applicationId };
    },
    put: async (route) => {
      routes.push(route);
      return [];
    },
  };
  const application = await resolveApplication(rest);
  assert.equal(await registerCommands(rest, application.id), commands.length);
  assert.deepEqual(routes, [Routes.oauth2CurrentApplication(), Routes.applicationCommands(applicationId)]);
});

test('DM appeal registration upserts one DM-only command without overwriting the global list', async () => {
  const appeal = commands.find((command) => command.name === 'appeal');
  assert.ok(appeal);
  const original = appeal.toJSON();
  const calls: { route: string; body: unknown }[] = [];
  // This adapter deliberately exposes no PUT: using a bulk overwrite must fail.
  const rest: Pick<REST, 'post'> = {
    post: async (route, options) => {
      calls.push({ route, body: options?.body });
      return {};
    },
  };
  assert.equal(await registerDmAppeal(rest, applicationId), undefined);
  assert.deepEqual(calls, [{
    route: Routes.applicationCommands(applicationId),
    body: { ...original, contexts: [InteractionContextType.BotDM] },
  }]);
  assert.deepEqual(appeal.toJSON(), original, 'registering a DM copy must not mutate the shared builder');
});

test('DM appeal registration rejects invalid application IDs before making any POST', async () => {
  let postCalls = 0;
  const rest: Pick<REST, 'post'> = {
    post: async () => {
      postCalls += 1;
      return {};
    },
  };
  for (const id of ['', 'invalid-sensitive-id', '1234567890123456', '123456789012345678901', ` ${applicationId} `]) {
    await assert.rejects(registerDmAppeal(rest, id), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      if (id) assert.ok(!error.message.includes(id));
      return true;
    });
  }
  assert.equal(postCalls, 0);
});

test('DM appeal registration accepts supported ID boundaries and propagates POST failures', async () => {
  for (const id of ['12345678901234567', '12345678901234567890']) {
    const routes: string[] = [];
    await registerDmAppeal({ post: async (route) => { routes.push(route); return {}; } }, id);
    assert.deepEqual(routes, [Routes.applicationCommands(id)]);
  }
  const failure = Object.assign(new Error('synthetic request failure'), { code: 50001 });
  await assert.rejects(registerDmAppeal({ post: async () => { throw failure; } }, applicationId),
    (error: unknown) => error === failure);
});
