import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApplicationCommandOptionType,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
} from 'discord.js';
import { commands, permissionForCommand } from '../src/commands.js';

const serialized = commands.map((command) => command.toJSON());

function getCommand(name: string) {
  const command = serialized.find((candidate) => candidate.name === name);
  assert.ok(command, `Missing /${name} command`);
  return command;
}

function getOption(commandName: string, optionName: string) {
  const option = getCommand(commandName).options?.find((candidate) => candidate.name === optionName);
  assert.ok(option, `Missing /${commandName} ${optionName} option`);
  return option;
}

test('serializes the command allowlist with guild-only contexts', () => {
  assert.deepEqual(serialized.map((command) => command.name), [
    'help', 'ping', 'warn', 'warnings', 'timeout', 'untimeout',
    'kick', 'ban', 'unban', 'clear', 'config',
  ]);
  for (const command of serialized) {
    assert.deepEqual(command.contexts, [InteractionContextType.Guild], `/${command.name} must be guild-only`);
    assert.ok(command.description.length > 0);
    assert.ok(command.description.length <= 100);
  }
});

test('management commands require their least-privilege defaults without Administrator', () => {
  const expected = new Map<string, bigint>([
    ['warn', PermissionFlagsBits.ModerateMembers],
    ['warnings', PermissionFlagsBits.ModerateMembers],
    ['timeout', PermissionFlagsBits.ModerateMembers],
    ['untimeout', PermissionFlagsBits.ModerateMembers],
    ['kick', PermissionFlagsBits.KickMembers],
    ['ban', PermissionFlagsBits.BanMembers],
    ['unban', PermissionFlagsBits.BanMembers],
    ['clear', PermissionFlagsBits.ManageMessages],
    ['config', PermissionFlagsBits.ManageGuild],
  ]);
  for (const command of serialized) {
    const permission = expected.get(command.name);
    assert.equal(command.default_member_permissions, permission?.toString(), `/${command.name} default permission`);
    assert.equal(permissionForCommand(command.name), permission ?? null);
    if (command.default_member_permissions !== undefined && command.default_member_permissions !== null) {
      assert.equal(BigInt(command.default_member_permissions) & PermissionFlagsBits.Administrator, 0n);
    }
  }
  assert.equal(permissionForCommand('not-a-command'), null);
});

test('member moderation requires a target and a bounded reason', () => {
  for (const commandName of ['warn', 'timeout', 'untimeout', 'kick', 'ban']) {
    const user = getOption(commandName, 'user');
    assert.ok(user.type === ApplicationCommandOptionType.User);
    assert.equal(user.required, true);
  }
  const warningsUser = getOption('warnings', 'user');
  assert.ok(warningsUser.type === ApplicationCommandOptionType.User);
  assert.equal(warningsUser.required, true);

  for (const commandName of ['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban']) {
    const reason = getOption(commandName, 'reason');
    assert.ok(reason.type === ApplicationCommandOptionType.String);
    assert.equal(reason.required, true);
    assert.equal(reason.max_length, 512);
  }
  const userId = getOption('unban', 'user_id');
  assert.ok(userId.type === ApplicationCommandOptionType.String);
  assert.equal(userId.required, true);
  assert.equal(userId.min_length, 17);
  assert.equal(userId.max_length, 20);
});

test('Discord action options enforce timeout, deletion, and cleanup API limits', () => {
  const minutes = getOption('timeout', 'minutes');
  assert.ok(minutes.type === ApplicationCommandOptionType.Integer);
  assert.equal(minutes.required, true);
  assert.equal(minutes.min_value, 1);
  assert.equal(minutes.max_value, 28 * 24 * 60);

  const days = getOption('ban', 'delete_days');
  assert.ok(days.type === ApplicationCommandOptionType.Integer);
  assert.notEqual(days.required, true);
  assert.equal(days.min_value, 0);
  assert.equal(days.max_value, 7);

  const amount = getOption('clear', 'amount');
  assert.ok(amount.type === ApplicationCommandOptionType.Integer);
  assert.equal(amount.required, true);
  assert.equal(amount.min_value, 1);
  assert.equal(amount.max_value, 100);
});

test('configuration permits only supported destination channels and bounded welcome text', () => {
  const config = getCommand('config');
  assert.deepEqual(config.options?.map((option) => option.name), ['view', 'logs', 'welcome', 'welcome-message']);
  for (const name of ['logs', 'welcome']) {
    const subcommand = getOption('config', name);
    assert.ok(subcommand.type === ApplicationCommandOptionType.Subcommand);
    const channel = subcommand.options?.find((option) => option.name === 'channel');
    assert.ok(channel?.type === ApplicationCommandOptionType.Channel);
    assert.notEqual(channel.required, true, 'omitting the channel must remain possible to disable delivery');
    assert.deepEqual(channel.channel_types, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
  }
  const welcome = getOption('config', 'welcome-message');
  assert.ok(welcome.type === ApplicationCommandOptionType.Subcommand);
  const message = welcome.options?.find((option) => option.name === 'message');
  assert.ok(message?.type === ApplicationCommandOptionType.String);
  assert.equal(message.required, true);
  assert.equal(message.min_length, 1);
  assert.equal(message.max_length, 1000);
});
