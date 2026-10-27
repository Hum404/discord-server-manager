import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, parseConfig } from '../src/config.js';

const validEnv = {
  DISCORD_TOKEN: 'secret-that-must-never-appear-in-validation-errors',
};

test('accepts a valid configuration and uses the persistent database default', () => {
  assert.deepEqual(parseConfig(validEnv), {
    token: validEnv.DISCORD_TOKEN,
    guildId: undefined,
    databasePath: './data/bot.sqlite',
  });
});

test('ignores all legacy application ids so old settings cannot block token-only upgrades', () => {
  for (const clientId of [undefined, '', ' ', 'YOUR_CLIENT_ID', '123', 'old-invalid-application-id', ' 123456789012345678 ', '987654321098765432']) {
    assert.deepEqual(parseConfig({ ...validEnv, DISCORD_CLIENT_ID: clientId }), {
      token: validEnv.DISCORD_TOKEN,
      guildId: undefined,
      databasePath: './data/bot.sqlite',
    });
  }
});

test('accepts optional guild registration and a custom database location', () => {
  const config = parseConfig({
    ...validEnv,
    DISCORD_GUILD_ID: ' 987654321098765432 ',
    DATABASE_PATH: ' /persistent/discord.sqlite ',
  });
  assert.equal(config.guildId, '987654321098765432');
  assert.equal(config.databasePath, '/persistent/discord.sqlite');
});

test('empty optional guild id uses global registration', () => {
  assert.equal(parseConfig({ ...validEnv, DISCORD_GUILD_ID: '  ' }).guildId, undefined);
});

test('rejects missing or placeholder bot tokens', () => {
  for (const token of [undefined, '', ' ', 'YOUR_BOT_TOKEN_HERE', 'replace-me', '貼上你的機器人 Token']) {
    assert.throws(() => parseConfig({ ...validEnv, DISCORD_TOKEN: token }), ConfigError);
  }
});

test('rejects invalid guild ids and null bytes in database paths', () => {
  assert.throws(() => parseConfig({ ...validEnv, DISCORD_GUILD_ID: 'not-an-id' }), ConfigError);
  assert.throws(() => parseConfig({ ...validEnv, DATABASE_PATH: 'bad\0path' }), ConfigError);
});

test('configuration errors never include supplied secrets or invalid values', () => {
  const secret = validEnv.DISCORD_TOKEN;
  try {
    parseConfig({ ...validEnv, DISCORD_GUILD_ID: 'secret-invalid-guild-id' });
    assert.fail('Expected validation to fail');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes('secret-invalid-guild-id'));
  }
});
