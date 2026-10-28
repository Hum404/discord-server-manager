import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
} from 'discord.js';
import {
  allCommands, commands, messageCommands, permissionForCommand,
  MESSAGE_APP_PIN_NAME, MESSAGE_APP_DELETE_NAME,
} from '../src/commands.js';

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
    'kick', 'ban', 'unban', 'clear', 'config', 'access', 'appeal', 'subarea', 'admin',
  ].sort());
  for (const command of serialized) {
    assert.deepEqual(command.contexts, command.name === 'appeal'
      ? [InteractionContextType.Guild, InteractionContextType.BotDM]
      : [InteractionContextType.Guild], `/${command.name} contexts`);
    assert.ok(command.description.length > 0);
    assert.ok(command.description.length <= 100);
  }
});

test('message APP actions target selected messages and retain runtime channel authorization', () => {
  const menus = messageCommands.map((command) => command.toJSON());
  assert.deepEqual(menus.map((command) => command.name), [MESSAGE_APP_PIN_NAME, MESSAGE_APP_DELETE_NAME]);
  assert.equal(allCommands.length, commands.length + 2);
  assert.equal(commands.length, 15, 'existing slash commands remain available separately');
  for (const menu of menus) {
    assert.equal(menu.type, ApplicationCommandType.Message);
    assert.deepEqual(menu.contexts, [InteractionContextType.Guild]);
    assert.deepEqual(menu.integration_types, [ApplicationIntegrationType.GuildInstall]);
    assert.equal(menu.default_member_permissions, null, 'creators without native pin permission must reach runtime checks');
    assert.equal(Object.hasOwn(menu, 'description'), false);
    assert.equal(Object.hasOwn(menu, 'options'), false);
    assert.ok(menu.name.length >= 1 && menu.name.length <= 32);
  }
  const identities = allCommands.map((command) => {
    const definition = command.toJSON();
    return `${definition.type ?? ApplicationCommandType.ChatInput}:${definition.name}`;
  });
  assert.equal(new Set(identities).size, identities.length);
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
    ['admin', PermissionFlagsBits.ManageGuild],
  ]);
  for (const command of serialized) {
    const permission = expected.get(command.name);
    assert.equal(permissionForCommand(command.name), permission ?? null);
    if (['config', 'access', 'admin'].includes(command.name)) {
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
  const expectedSubcommands = ['create', 'assign', 'list', 'mute', 'unmute', 'kick', 'unkick', 'tag', 'role-tag', 'announce',
    'pin', 'unpin', 'delete-message', 'slowmode', 'rename', 'lock', 'unlock', 'delete', 'delegate', 'undelegate', 'delegates', 'info'];
  assert.deepEqual(getCommand('subarea').options?.map((option) => option.name).sort(), expectedSubcommands.sort());
  const name = getSubOption('subarea', 'create', 'name');
  assert.ok(name.type === ApplicationCommandOptionType.String);
  assert.equal(name.required, true);
  assert.equal(name.max_length, 80);
  const channel = getSubOption('subarea', 'assign', 'channel');
  assert.ok(channel.type === ApplicationCommandOptionType.Channel);
  assert.equal(channel.required, true);
  assert.deepEqual(channel.channel_types, [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);
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


test('subarea destinations preserve text channels and allow explicit thread or forum creation', () => {
  const forum = getSubOption('config', 'subareas', 'forum');
  assert.ok(forum.type === ApplicationCommandOptionType.Channel);
  assert.notEqual(forum.required, true);
  assert.deepEqual(forum.channel_types, [ChannelType.GuildForum]);
  const type = getSubOption('subarea', 'create', 'type');
  assert.ok(type.type === ApplicationCommandOptionType.String);
  assert.notEqual(type.required, true);
  assert.deepEqual(type.choices?.map((choice) => choice.value), ['text', 'thread', 'forum']);
  const parent = getSubOption('subarea', 'create', 'parent');
  assert.ok(parent.type === ApplicationCommandOptionType.Channel);
  assert.deepEqual(parent.channel_types, [ChannelType.GuildText, ChannelType.GuildForum]);
  const content = getSubOption('subarea', 'create', 'content');
  assert.ok(content.type === ApplicationCommandOptionType.String);
  assert.equal(content.max_length, 2000);
  assert.notEqual(content.required, true);
});

test('local tools distinguish message pinning, slowmode and delegate targets', () => {
  for (const operation of ['pin', 'unpin', 'delete-message']) {
    const message = getSubOption('subarea', operation, 'message');
    assert.ok(message.type === ApplicationCommandOptionType.String);
    assert.equal(message.required, true);
    assert.equal(message.max_length, 200);
  }
  const seconds = getSubOption('subarea', 'slowmode', 'seconds');
  assert.ok(seconds.type === ApplicationCommandOptionType.Integer);
  assert.equal(seconds.min_value, 0);
  assert.equal(seconds.max_value, 21600);
  assert.equal(seconds.required, true);
  for (const operation of ['delegate', 'undelegate']) {
    const user = getSubOption('subarea', operation, 'user');
    assert.ok(user.type === ApplicationCommandOptionType.User);
    assert.equal(user.required, true);
  }
  assert.match(getOption('subarea', 'pin').description, /置頂/);
  assert.match(getOption('subarea', 'tag').description, /提及/);
});

test('administrator operations bound case IDs, native-management inputs and editable channel types', () => {
  assert.deepEqual(getCommand('admin').options?.map((option) => option.name).sort(),
    ['cases', 'case', 'warning-remove', 'role-add', 'role-remove', 'channel-edit'].sort());
  for (const operation of ['case', 'warning-remove']) {
    const id = getSubOption('admin', operation, 'id');
    assert.ok(id.type === ApplicationCommandOptionType.Integer);
    assert.equal(id.min_value, 1);
    assert.equal(id.required, true);
  }
  for (const operation of ['warning-remove', 'role-add', 'role-remove', 'channel-edit']) {
    const reason = getSubOption('admin', operation, 'reason');
    assert.ok(reason.type === ApplicationCommandOptionType.String);
    assert.equal(reason.required, true);
    assert.equal(reason.max_length, 512);
  }
  for (const operation of ['role-add', 'role-remove']) {
    const user = getSubOption('admin', operation, 'user');
    const role = getSubOption('admin', operation, 'role');
    assert.ok(user.type === ApplicationCommandOptionType.User);
    assert.ok(role.type === ApplicationCommandOptionType.Role);
    assert.equal(user.required, true);
    assert.equal(role.required, true);
  }
  const channel = getSubOption('admin', 'channel-edit', 'channel');
  assert.ok(channel.type === ApplicationCommandOptionType.Channel);
  assert.equal(channel.required, true);
  assert.deepEqual(channel.channel_types, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
  const slowmode = getSubOption('admin', 'channel-edit', 'slowmode');
  assert.ok(slowmode.type === ApplicationCommandOptionType.Integer);
  assert.equal(slowmode.min_value, 0);
  assert.equal(slowmode.max_value, 21600);
  const nsfw = getSubOption('admin', 'channel-edit', 'nsfw');
  assert.ok(nsfw.type === ApplicationCommandOptionType.Boolean);
  assert.notEqual(nsfw.required, true);
});

test('nested command schemas obey Discord option limits and required-before-optional ordering', () => {
  function checkOptions(options: NonNullable<(typeof serialized)[number]['options']>): void {
    assert.ok(options.length <= 25, 'Discord supports at most 25 options per command');
    let optionalSeen = false;
    for (const option of options) {
      if (option.type === ApplicationCommandOptionType.Subcommand || option.type === ApplicationCommandOptionType.SubcommandGroup) {
        checkOptions(option.options ?? []);
      } else {
        if (!option.required) optionalSeen = true;
        else assert.equal(optionalSeen, false, `required option ${option.name} follows an optional option`);
      }
    }
  }
  for (const command of serialized) checkOptions(command.options ?? []);
});
