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

function getSubOption(commandName: string, subcommandName: string, optionName: string) {
  const subcommand = getOption(commandName, subcommandName);
  assert.ok(subcommand.type === ApplicationCommandOptionType.Subcommand);
  const option = subcommand.options?.find((candidate) => candidate.name === optionName);
  assert.ok(option, `Missing /${commandName} ${subcommandName} ${optionName} option`);
  return option;
}

test('serializes the command allowlist with appeals available in bot DMs', () => {
  assert.deepEqual(serialized.map((command) => command.name).sort(), [
    'help', 'ping', 'warn', 'warnings', 'timeout', 'untimeout',
    'kick', 'ban', 'unban', 'clear', 'config', 'access', 'appeal', 'subarea',
  ].sort());
  for (const command of serialized) {
    assert.deepEqual(command.contexts, command.name === 'appeal'
      ? [InteractionContextType.Guild, InteractionContextType.BotDM]
      : [InteractionContextType.Guild], `/${command.name} contexts`);
    assert.ok(command.description.length > 0);
    assert.ok(command.description.length <= 100);
  }
});

test('delegatable management commands remain visible while preserving runtime permission requirements', () => {
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
    ['access', PermissionFlagsBits.Administrator],
  ]);
  for (const command of serialized) {
    const permission = expected.get(command.name);
    assert.equal(permissionForCommand(command.name), permission ?? null);
    if (command.name === 'config' || command.name === 'access') {
      assert.equal(command.default_member_permissions, permission!.toString(), `/${command.name} must keep its native restriction`);
    } else {
      assert.ok(command.default_member_permissions == null,
        `/${command.name} must allow application-managed authorization at runtime`);
    }
  }
  assert.equal(permissionForCommand('not-a-command'), null);
  assert.equal(permissionForCommand('constructor'), null);
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
  assert.deepEqual(config.options?.map((option) => option.name).sort(),
    ['view', 'logs', 'welcome', 'welcome-message', 'appeals', 'subareas'].sort());
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

  const appealsChannel = getSubOption('config', 'appeals', 'channel');
  assert.ok(appealsChannel.type === ApplicationCommandOptionType.Channel);
  assert.notEqual(appealsChannel.required, true);
  assert.deepEqual(appealsChannel.channel_types, [ChannelType.GuildText]);
  const subareaCategory = getSubOption('config', 'subareas', 'category');
  assert.ok(subareaCategory.type === ApplicationCommandOptionType.Channel);
  assert.notEqual(subareaCategory.required, true);
  assert.deepEqual(subareaCategory.channel_types, [ChannelType.GuildCategory]);
});

test('access grants use bounded capabilities with an explicit all option and revocable targets', () => {
  assert.deepEqual(getCommand('access').options?.map((option) => option.name).sort(), ['grant', 'revoke', 'list'].sort());
  const expectedScopes = ['all', 'warn', 'timeout', 'kick', 'ban', 'clear'].sort();
  for (const subcommand of ['grant', 'revoke']) {
    const user = getSubOption('access', subcommand, 'user');
    assert.ok(user.type === ApplicationCommandOptionType.User);
    assert.equal(user.required, true);
    const scope = getSubOption('access', subcommand, 'scope');
    assert.ok(scope.type === ApplicationCommandOptionType.String);
    assert.deepEqual(scope.choices?.map((choice) => choice.value).sort(), expectedScopes);
    assert.equal(scope.required === true, subcommand === 'grant');
  }
  const user = getSubOption('access', 'list', 'user');
  assert.ok(user.type === ApplicationCommandOptionType.User);
  assert.notEqual(user.required, true);
});

test('appeal submissions need no staff permission and review input is bounded', () => {
  assert.deepEqual(getCommand('appeal').options?.map((option) => option.name).sort(),
    ['submit', 'status', 'queue', 'review'].sort());
  for (const [subcommand, name] of [['submit', 'case'], ['status', 'id'], ['queue', 'id']] as const) {
    const id = getSubOption('appeal', subcommand, name);
    assert.ok(id.type === ApplicationCommandOptionType.Integer);
    assert.notEqual(id.required, true);
    assert.equal(id.min_value, 1);
  }
  const status = getSubOption('appeal', 'queue', 'status');
  assert.ok(status.type === ApplicationCommandOptionType.String);
  assert.notEqual(status.required, true);
  assert.deepEqual(status.choices?.map((choice) => choice.value).sort(), ['open', 'accepted', 'rejected'].sort());

  const id = getSubOption('appeal', 'review', 'id');
  assert.ok(id.type === ApplicationCommandOptionType.Integer);
  assert.equal(id.required, true);
  assert.equal(id.min_value, 1);
  const result = getSubOption('appeal', 'review', 'result');
  assert.ok(result.type === ApplicationCommandOptionType.String);
  assert.equal(result.required, true);
  assert.deepEqual(result.choices?.map((choice) => choice.value).sort(), ['accepted', 'rejected'].sort());
  const reason = getSubOption('appeal', 'review', 'reason');
  assert.ok(reason.type === ApplicationCommandOptionType.String);
  assert.equal(reason.required, true);
  assert.equal(reason.max_length, 1000);
});

test('subarea creation, assignment and local restrictions have explicit targets and bounded input', () => {
  const expectedSubcommands = ['create', 'assign', 'list', 'mute', 'unmute', 'kick', 'unkick', 'tag', 'role-tag', 'announce'];
  assert.deepEqual(getCommand('subarea').options?.map((option) => option.name).sort(), expectedSubcommands.sort());
  const name = getSubOption('subarea', 'create', 'name');
  assert.ok(name.type === ApplicationCommandOptionType.String);
  assert.equal(name.required, true);
  assert.equal(name.max_length, 80);
  const channel = getSubOption('subarea', 'assign', 'channel');
  assert.ok(channel.type === ApplicationCommandOptionType.Channel);
  assert.equal(channel.required, true);
  assert.deepEqual(channel.channel_types, [ChannelType.GuildText]);
  const owner = getSubOption('subarea', 'assign', 'user');
  assert.ok(owner.type === ApplicationCommandOptionType.User);
  assert.equal(owner.required, true);

  for (const action of ['mute', 'unmute', 'kick', 'unkick']) {
    const user = getSubOption('subarea', action, 'user');
    assert.ok(user.type === ApplicationCommandOptionType.User);
    assert.equal(user.required, true);
    const reason = getSubOption('subarea', action, 'reason');
    assert.ok(reason.type === ApplicationCommandOptionType.String);
    assert.equal(reason.required === true, action === 'mute' || action === 'kick');
    assert.equal(reason.max_length, 512);
  }
});

test('subarea mentions specify the audience and limit notification content', () => {
  const user = getSubOption('subarea', 'tag', 'user');
  assert.ok(user.type === ApplicationCommandOptionType.User);
  assert.equal(user.required, true);
  const role = getSubOption('subarea', 'role-tag', 'role');
  assert.ok(role.type === ApplicationCommandOptionType.Role);
  assert.equal(role.required, true);
  for (const action of ['tag', 'role-tag', 'announce']) {
    const message = getSubOption('subarea', action, 'message');
    assert.ok(message.type === ApplicationCommandOptionType.String);
    assert.equal(message.max_length, 500);
    assert.equal(message.required === true, action === 'announce');
  }
  const audience = getSubOption('subarea', 'announce', 'audience');
  assert.ok(audience.type === ApplicationCommandOptionType.String);
  assert.equal(audience.required, true);
  assert.deepEqual(audience.choices?.map((choice) => choice.value).sort(), ['everyone', 'here']);
});
