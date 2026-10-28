import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField, type ChatInputCommandInteraction } from 'discord.js';
import { handleAdminCommand } from '../src/admin.js';
import { UserError } from '../src/errors.js';
import { Store } from '../src/store.js';

const ids = {
  guild: '100000000000000101', otherGuild: '100000000000000102', actor: '100000000000000103',
  target: '100000000000000104', bot: '100000000000000105', owner: '100000000000000106',
  channel: '100000000000000107', role: '100000000000000108',
};

function role(id: string, position: number, permissions: bigint[] = []) {
  return {
    id, position, guild: { id: ids.guild }, managed: false, editable: true,
    permissions: new PermissionsBitField(permissions),
    comparePositionTo(other: { position: number }) { return this.position - other.position; },
  };
}

function fixture(subcommand: string) {
  const actorRole = role('100000000000000111', 30);
  const botRole = role('100000000000000112', 40);
  const targetRole = role('100000000000000113', 5);
  const selectedRole = role(ids.role, 10);
  const writes: unknown[][] = [];
  const replies: unknown[] = [];
  const state = {
    id: 1, reason: '已確認需要修正', name: null as string | null,
    slowmode: null as number | null, nsfw: null as boolean | null,
    selectedUser: null as { id: string } | null,
    onFetch: (_id: string) => {}, onConfirm: () => {}, accepted: true,
    failure: null as unknown, roleRefreshCount: 0,
    actorChannelPermissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]),
    botChannelPermissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]),
  };
  function member(id: string, highest: ReturnType<typeof role>, permissions: bigint[] = []) {
    return {
      id, guild: { id: ids.guild }, user: { id, bot: id === ids.bot }, manageable: true,
      permissions: new PermissionsBitField(permissions),
      roles: {
        highest, cache: new Collection<string, unknown>(),
        async add(roleId: string, explanation: string) {
          if (state.failure) throw state.failure;
          writes.push(['role-add', id, roleId, explanation]);
        },
        async remove(roleId: string, explanation: string) {
          if (state.failure) throw state.failure;
          writes.push(['role-remove', id, roleId, explanation]);
        },
      },
    };
  }
  const actor = member(ids.actor, actorRole, [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels]);
  const bot = member(ids.bot, botRole, [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels]);
  const target = member(ids.target, targetRole);
  const members = new Map([[actor.id, actor], [target.id, target], [bot.id, bot]]);
  const roles = new Collection([[selectedRole.id, selectedRole], [actorRole.id, actorRole], [botRole.id, botRole], [targetRole.id, targetRole]]);
  const channel = {
    id: ids.channel, guildId: ids.guild, type: ChannelType.GuildText as ChannelType,
    permissionsFor(who: { id: string }) { return who.id === bot.id ? state.botChannelPermissions : state.actorChannelPermissions; },
    async edit(changes: unknown) {
      if (state.failure) throw state.failure;
      writes.push(['channel-edit', changes]);
    },
  };
  const command = {
    id: 'test-admin-command', guildId: ids.guild, channelId: ids.channel, user: actor.user,
    guild: {
      id: ids.guild, ownerId: ids.owner,
      roles: {
        cache: roles,
        async fetch(id?: string, options?: { force: boolean }) {
          if (id) {
            assert.equal(options?.force, true);
            state.onFetch(`role:${id}`);
            return roles.get(id) ?? null;
          }
          state.roleRefreshCount++;
          return roles;
        },
      },
      members: {
        async fetch(options: { user: string; force: boolean }) {
          assert.equal(options.force, true);
          state.onFetch(options.user);
          const found = members.get(options.user);
          if (!found) throw { code: 10007 };
          return found;
        },
        async fetchMe(options: { force: boolean }) { assert.equal(options.force, true); return bot; },
      },
      channels: { async fetch(id: string, options: { force: boolean }) {
        assert.equal(options.force, true);
        state.onFetch(`channel:${id}`);
        return id === channel.id ? channel : null;
      } },
    },
    options: {
      getSubcommand: () => subcommand,
      getInteger: (name: string) => name === 'id' ? state.id : state.slowmode,
      getString: (name: string) => name === 'reason' ? state.reason : state.name,
      getBoolean: () => state.nsfw,
      getUser: () => state.selectedUser ?? (subcommand === 'cases' ? null : target.user),
      getRole: () => selectedRole,
      getChannel: () => channel,
    },
    async editReply(payload: unknown) {
      replies.push(payload);
      return {
        async awaitMessageComponent(options: { filter: (button: { user: { id: string }; customId: string }) => boolean; time: number }) {
          assert.equal(options.time, 30_000);
          assert.equal(options.filter({ user: { id: ids.target }, customId: 'admin:warning-remove:test-admin-command' }), false);
          assert.equal(options.filter({ user: actor.user, customId: 'forged' }), false);
          state.onConfirm();
          return { customId: state.accepted ? 'admin:warning-remove:test-admin-command' : 'admin:cancel:test-admin-command',
            async update(update: unknown) { replies.push(update); } };
        },
      };
    },
  };
  return { state, actor, bot, target, selectedRole, roles, members, channel, writes, replies,
    command: command as unknown as ChatInputCommandInteraction<'cached'> };
}

function withStore(run: (store: Store) => Promise<void>) {
  return async () => { const store = new Store(':memory:'); try { await run(store); } finally { store.close(); } };
}

test('admin case detail is guild-scoped and private output suppresses mentions', withStore(async (store) => {
  const f = fixture('case');
  const own = store.addCase({ guildId: ids.guild, moderatorId: ids.actor, userId: ids.target, action: 'warn', reason: '本服紀錄' });
  const other = store.addCase({ guildId: ids.otherGuild, moderatorId: ids.actor, userId: ids.target, action: 'ban', reason: '別服私密紀錄' });
  f.state.id = other.id;
  await assert.rejects(handleAdminCommand(f.command, store), /找不到此伺服器的案件/);
  assert.equal(f.replies.length, 0);
  f.state.id = own.id;
  await handleAdminCommand(f.command, store);
  assert.deepEqual((f.replies[0] as { allowedMentions: unknown }).allowedMentions, { parse: [] });
  assert.match(JSON.stringify(f.replies), /本服紀錄/);
  assert.doesNotMatch(JSON.stringify(f.replies), /別服私密紀錄/);
}));

test('admin case list filters optional member within current guild', withStore(async (store) => {
  const f = fixture('cases');
  f.state.selectedUser = { id: ids.target };
  for (const [guildId, userId, reason] of [[ids.guild, ids.target, '指定成員'], [ids.guild, ids.actor, '其他成員'], [ids.otherGuild, ids.target, '別服紀錄']]) {
    store.addCase({ guildId: guildId!, userId: userId!, moderatorId: ids.actor, action: 'warn', reason: reason! });
  }
  await handleAdminCommand(f.command, store);
  assert.match(JSON.stringify(f.replies), /指定成員/);
  assert.doesNotMatch(JSON.stringify(f.replies), /其他成員|別服紀錄/);
}));

test('server case queries omit member activity while keeping sanction targets and original case numbers', withStore(async (store) => {
  const f = fixture('cases');
  const member = store.addCase({ guildId: ids.guild, moderatorId: ids.actor, userId: ids.target,
    action: 'subarea-kick', reason: '只限子區的私人操作' });
  const server = store.addCase({ guildId: ids.guild, moderatorId: ids.actor, userId: ids.target,
    action: 'kick', reason: '整服踢出紀錄' });
  await handleAdminCommand(f.command, store);
  assert.match(JSON.stringify(f.replies), /整服踢出紀錄/);
  assert.doesNotMatch(JSON.stringify(f.replies), /只限子區的私人操作/);
  assert.match(JSON.stringify(f.replies), new RegExp(`#${server.caseNumber}`));
  const detail = fixture('case');
  detail.state.id = member.caseNumber;
  await assert.rejects(handleAdminCommand(detail.command, store), /records/);
  assert.equal(detail.replies.length, 0);
  assert.equal(store.getGuildCase(ids.guild, member.caseNumber)?.reason, '只限子區的私人操作');
}));

test('admin case numbers are local even when another guild has already created several cases', withStore(async (store) => {
  const f = fixture('case');
  for (let i = 0; i < 3; i++) {
    store.addCase({ guildId: ids.otherGuild, moderatorId: ids.actor, userId: ids.target, action: 'warn', reason: '別服私密紀錄' });
  }
  const own = store.addCase({ guildId: ids.guild, moderatorId: ids.actor, userId: ids.target, action: 'warn', reason: '本服第一件' });
  assert.equal(own.caseNumber, 1);
  assert.notEqual(own.id, own.caseNumber);
  f.state.id = 1;
  await handleAdminCommand(f.command, store);
  assert.match(JSON.stringify(f.replies), /本服案件 #1/);
  assert.match(JSON.stringify(f.replies), /本服第一件/);
  assert.doesNotMatch(JSON.stringify(f.replies), /別服私密紀錄/);
  const listing = fixture('cases');
  await handleAdminCommand(listing.command, store);
  assert.match(JSON.stringify(listing.replies.at(-1)), /#1/);
  assert.doesNotMatch(JSON.stringify(listing.replies.at(-1)), /#4/);
}));

test('Bot moderation grants cannot authorize native admin commands', withStore(async (store) => {
  const f = fixture('cases');
  f.actor.permissions.remove(PermissionFlagsBits.ManageGuild);
  store.setGrant(ids.guild, ids.actor, 'warn', ids.owner);
  await assert.rejects(handleAdminCommand(f.command, store), /原生管理伺服器/);
  assert.equal(f.replies.length, 0);
}));

test('warning removal confirms, removes only active warning and retains original case', withStore(async (store) => {
  const f = fixture('warning-remove');
  const warning = store.addWarning({ guildId: ids.guild, userId: ids.target, moderatorId: ids.actor, reason: '原警告' });
  const original = store.addCase({ guildId: ids.guild, userId: ids.target, moderatorId: ids.actor, reason: '原警告', action: 'warn' });
  f.state.id = warning.id;
  await handleAdminCommand(f.command, store);
  assert.equal(store.getWarning(ids.guild, warning.id), null);
  assert.deepEqual({ ...store.getCase(original.id)! }, original);
  const audit = store.listCases(ids.guild)[0]!;
  assert.equal(audit.action, 'warning-remove');
  assert.match(audit.details!, /原警告/);
}));

test('warning removal cancellation leaves warning and cases untouched', withStore(async (store) => {
  const f = fixture('warning-remove');
  const warning = store.addWarning({ guildId: ids.guild, userId: ids.target, moderatorId: ids.actor, reason: '保留' });
  f.state.id = warning.id;
  f.state.accepted = false;
  await handleAdminCommand(f.command, store);
  assert.ok(store.getWarning(ids.guild, warning.id));
  assert.equal(store.listCases(ids.guild).length, 0);
}));

test('warning from another guild cannot be previewed or removed', withStore(async (store) => {
  const f = fixture('warning-remove');
  const warning = store.addWarning({ guildId: ids.otherGuild, userId: ids.target, moderatorId: ids.actor, reason: '保密' });
  f.state.id = warning.id;
  await assert.rejects(handleAdminCommand(f.command, store), /找不到此伺服器的警告/);
  assert.equal(f.replies.length, 0);
  assert.ok(store.getWarning(ids.otherGuild, warning.id));
}));

test('warning removal refreshes native permission after confirmation', withStore(async (store) => {
  const f = fixture('warning-remove');
  const warning = store.addWarning({ guildId: ids.guild, userId: ids.target, moderatorId: ids.actor, reason: '保留' });
  f.state.id = warning.id;
  f.state.onConfirm = () => { f.actor.permissions.remove(PermissionFlagsBits.ManageGuild); };
  await assert.rejects(handleAdminCommand(f.command, store), /原生管理伺服器/);
  assert.ok(store.getWarning(ids.guild, warning.id));
  assert.equal(store.listCases(ids.guild).length, 0);
}));

test('concurrent warning removal is reported without a duplicate audit', withStore(async (store) => {
  const f = fixture('warning-remove');
  const warning = store.addWarning({ guildId: ids.guild, userId: ids.target, moderatorId: ids.actor, reason: '已處理' });
  f.state.id = warning.id;
  f.state.onConfirm = () => { store.removeWarning(ids.guild, warning.id); };
  await assert.rejects(handleAdminCommand(f.command, store), /其他管理員/);
  assert.equal(store.listCases(ids.guild).length, 0);
}));

test('role add changes exactly one role and audits after success', withStore(async (store) => {
  const f = fixture('role-add');
  await handleAdminCommand(f.command, store);
  assert.deepEqual(f.writes[0]?.slice(0, 3), ['role-add', ids.target, ids.role]);
  assert.match(String(f.writes[0]?.[3]), new RegExp(ids.actor));
  assert.equal(store.listCases(ids.guild)[0]?.action, 'role-add');
}));

test('role remove uses a single-role endpoint and no-op adds do not audit', withStore(async (store) => {
  const removal = fixture('role-remove');
  removal.target.roles.cache.set(ids.role, removal.selectedRole);
  await handleAdminCommand(removal.command, store);
  assert.deepEqual(removal.writes[0]?.slice(0, 3), ['role-remove', ids.target, ids.role]);
  const add = fixture('role-add');
  add.target.roles.cache.set(ids.role, add.selectedRole);
  await handleAdminCommand(add.command, store);
  assert.equal(add.writes.length, 0);
  assert.equal(store.listCases(ids.guild).length, 1);
}));

test('role edit requires native ManageRoles in addition to ManageGuild', withStore(async (store) => {
  const f = fixture('role-add');
  f.actor.permissions.remove(PermissionFlagsBits.ManageRoles);
  await assert.rejects(handleAdminCommand(f.command, store), /原生管理伺服器/);
  assert.equal(f.writes.length, 0);
}));

test('role edit rechecks authority after target lookup', withStore(async (store) => {
  const f = fixture('role-add');
  f.state.onFetch = (id) => { if (id === ids.target) f.actor.permissions.remove(PermissionFlagsBits.ManageRoles); };
  await assert.rejects(handleAdminCommand(f.command, store), /原生管理伺服器/);
  assert.equal(f.writes.length, 0);
}));

test('role edit rejects managed roles, protected targets and equal hierarchy', withStore(async (store) => {
  const managed = fixture('role-add');
  managed.selectedRole.managed = true;
  await assert.rejects(handleAdminCommand(managed.command, store), /整合服務/);
  const protectedTarget = fixture('role-add');
  protectedTarget.target.permissions.add(PermissionFlagsBits.Administrator);
  await assert.rejects(handleAdminCommand(protectedTarget.command, store), /管理員的身分組/);
  const hierarchy = fixture('role-add');
  hierarchy.selectedRole.position = hierarchy.actor.roles.highest.position;
  await assert.rejects(handleAdminCommand(hierarchy.command, store), /你的最高角色/);
  assert.equal(store.listCases(ids.guild).length, 0);
}));

test('non-Administrator cannot assign or remove dangerous permission roles', withStore(async (store) => {
  for (const command of ['role-add', 'role-remove']) {
    const f = fixture(command);
    f.target.roles.cache.set(ids.role, f.selectedRole);
    f.selectedRole.permissions.add(PermissionFlagsBits.ManageRoles);
    await assert.rejects(handleAdminCommand(f.command, store), /只有原生管理員/);
    assert.equal(f.writes.length, 0);
  }
}));

test('native Administrator may assign sensitive role below hierarchy but bot rank still applies', withStore(async (store) => {
  const f = fixture('role-add');
  f.actor.permissions.add(PermissionFlagsBits.Administrator);
  f.selectedRole.permissions.add(PermissionFlagsBits.ManageRoles);
  await handleAdminCommand(f.command, store);
  assert.equal(f.writes.length, 1);
  f.selectedRole.position = f.bot.roles.highest.position;
  await assert.rejects(handleAdminCommand(f.command, store), /最高角色/);
}));

test('failed role mutation does not create a success audit', withStore(async (store) => {
  const f = fixture('role-add');
  f.state.failure = { code: 50013 };
  await assert.rejects(handleAdminCommand(f.command, store), (error) => error === f.state.failure);
  assert.equal(store.listCases(ids.guild).length, 0);
}));

test('channel edit whitelists fields and supports disabling slowmode and NSFW', withStore(async (store) => {
  const f = fixture('channel-edit');
  f.state.name = ' 新頻道 ';
  f.state.slowmode = 0;
  f.state.nsfw = false;
  await handleAdminCommand(f.command, store);
  const changes = f.writes[0]?.[1] as Record<string, unknown>;
  assert.deepEqual(Object.keys(changes).sort(), ['name', 'nsfw', 'rateLimitPerUser', 'reason']);
  assert.equal(changes.name, '新頻道');
  assert.equal(changes.rateLimitPerUser, 0);
  assert.equal(changes.nsfw, false);
  assert.equal(store.listCases(ids.guild)[0]?.action, 'channel-edit');
}));

test('channel edit rejects invalid settings, unsupported thread and empty update', withStore(async (store) => {
  for (const setup of [
    (f: ReturnType<typeof fixture>) => { f.state.name = '\u0000'; },
    (f: ReturnType<typeof fixture>) => { f.state.slowmode = 21_601; },
    (_f: ReturnType<typeof fixture>) => {},
    (f: ReturnType<typeof fixture>) => { f.channel.type = ChannelType.PublicThread; f.state.name = '禁止'; },
  ]) {
    const f = fixture('channel-edit');
    setup(f);
    await assert.rejects(handleAdminCommand(f.command, store), UserError);
    assert.equal(f.writes.length, 0);
  }
}));

test('channel edit refreshes authority after channel lookup and honors channel denies', withStore(async (store) => {
  const revoked = fixture('channel-edit');
  revoked.state.name = '禁止';
  revoked.state.onFetch = (id) => { if (id.startsWith('channel:')) revoked.actor.permissions.remove(PermissionFlagsBits.ManageChannels); };
  await assert.rejects(handleAdminCommand(revoked.command, store), /原生管理伺服器/);
  const denied = fixture('channel-edit');
  denied.state.name = '禁止';
  denied.state.actorChannelPermissions.remove(PermissionFlagsBits.ManageChannels);
  await assert.rejects(handleAdminCommand(denied.command, store), /管理此頻道/);
  assert.equal(revoked.writes.length + denied.writes.length, 0);
}));

test('channel edit respects bot permissions and API failure without auditing success', withStore(async (store) => {
  const f = fixture('channel-edit');
  f.state.name = '禁止';
  f.state.botChannelPermissions.remove(PermissionFlagsBits.ManageChannels);
  await assert.rejects(handleAdminCommand(f.command, store), /機器人缺少/);
  f.state.botChannelPermissions.add(PermissionFlagsBits.ManageChannels);
  f.state.failure = { code: 50013 };
  await assert.rejects(handleAdminCommand(f.command, store), (error) => error === f.state.failure);
  assert.equal(store.listCases(ids.guild).length, 0);
}));
