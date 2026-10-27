import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PermissionsBitField, PermissionFlagsBits,
  type ChatInputCommandInteraction, type GuildBasedChannel, type GuildMember,
} from 'discord.js';
import { handleAccessCommand, resolveModerationAuthority } from '../src/access.js';
import { MANAGEMENT_SCOPES, scopeForCommand } from '../src/domain.js';
import { UserError } from '../src/errors.js';
import { Store } from '../src/store.js';

const ids = {
  guild: '100000000000000001', actor: '100000000000000002', issuer: '100000000000000003',
  recipient: '100000000000000004', owner: '100000000000000005', otherGuild: '100000000000000006',
};

function member(id: string, permissions: bigint[] = [], bot = false) {
  return {
    id, permissions: new PermissionsBitField(permissions),
    user: { id, bot }, roles: { highest: { position: id === ids.issuer ? 20 : 1 } },
  };
}

function fixture(commandName = 'warn') {
  const actor = member(ids.actor);
  const issuer = member(ids.issuer, [PermissionFlagsBits.Administrator]);
  const recipient = member(ids.recipient);
  const members = new Map([[actor.id, actor], [issuer.id, issuer], [recipient.id, recipient]]);
  const fetches: { user: string; force: boolean }[] = [];
  const edits: unknown[] = [];
  const state = {
    subcommand: 'grant', scope: 'warn' as string | null,
    selectedUser: recipient.user as { id: string; bot: boolean } | null,
    onFetch: (_id: string) => {},
    fetchError: null as unknown,
    channelPermissions: new PermissionsBitField(),
    roleRefreshes: 0,
  };
  const channel = {
    permissionsFor() { return state.channelPermissions; },
  };
  const command = {
    commandName, guildId: ids.guild, channelId: '100000000000000007', user: actor.user,
    guild: {
      ownerId: ids.owner,
      roles: { async fetch() { state.roleRefreshes += 1; } },
      members: { async fetch(options: { user: string; force: boolean }) {
        assert.equal(options.force, true);
        fetches.push(options);
        state.onFetch(options.user);
        if (state.fetchError) throw state.fetchError;
        const found = members.get(options.user);
        if (!found) throw { code: 10007 };
        return found;
      } },
    },
    options: {
      getSubcommand: () => state.subcommand,
      getUser: () => state.selectedUser,
      getString: () => state.scope,
    },
    async editReply(payload: unknown) { edits.push(payload); },
  };
  return {
    actor, issuer, recipient, members, fetches, state, edits,
    command: command as unknown as ChatInputCommandInteraction<'cached'>,
    channel: channel as unknown as GuildBasedChannel,
    actorMember: actor as unknown as GuildMember,
  };
}

test('management scope aliases share only their intended capability', () => {
  assert.equal(scopeForCommand('warnings'), 'warn');
  assert.equal(scopeForCommand('untimeout'), 'timeout');
  assert.equal(scopeForCommand('unban'), 'ban');
  for (const command of ['config', 'access', 'appeal', 'subarea', 'constructor']) {
    assert.equal(scopeForCommand(command), null);
  }
});

test('native permission holders use their own authority without consulting an issuer', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture();
    f.actor.permissions.add(PermissionFlagsBits.ModerateMembers);
    const resolved = await resolveModerationAuthority(f.command, f.actorMember, f.channel, store);
    assert.equal(resolved.authority, f.actor);
    assert.equal(resolved.delegated, false);
    assert.equal(f.fetches.length, 0);
  } finally { store.close(); }
});

test('server owners and native administrators never require a delegated grant', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('access');
    f.actor.permissions.add(PermissionFlagsBits.Administrator);
    assert.equal((await resolveModerationAuthority(f.command, f.actorMember, null, store)).delegated, false);
    f.actor.permissions.remove(PermissionFlagsBits.Administrator);
    f.command.guild.ownerId = f.actor.id;
    assert.equal((await resolveModerationAuthority(f.command, f.actorMember, null, store)).authority, f.actor);
    assert.equal(f.fetches.length, 0);
  } finally { store.close(); }
});

test('a valid grant borrows its freshly fetched administrator issuer authority', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('warnings');
    store.setGrant(ids.guild, ids.actor, 'warn', ids.issuer);
    const resolved = await resolveModerationAuthority(f.command, f.actorMember, f.channel, store);
    assert.equal(resolved.authority, f.issuer);
    assert.equal(resolved.delegated, true);
    assert.ok(resolved.authority.roles.highest.position > f.actor.roles.highest.position);
    assert.deepEqual(f.fetches, [{ user: ids.issuer, force: true }]);
  } finally { store.close(); }
});

test('grants never cross a capability or guild and cannot authorize grant/config management', async () => {
  const store = new Store(':memory:');
  try {
    store.setGrant(ids.guild, ids.actor, 'ban', ids.issuer);
    store.setGrant(ids.otherGuild, ids.actor, 'warn', ids.issuer);
    for (const name of ['warn', 'kick', 'config', 'access']) {
      const f = fixture(name);
      await assert.rejects(resolveModerationAuthority(f.command, f.actorMember, f.channel, store), UserError);
      assert.equal(f.fetches.length, 0);
    }
  } finally { store.close(); }
});

test('an issuer losing Administrator disables the grant while owner-issued grants remain valid', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('ban');
    store.setGrant(ids.guild, ids.actor, 'ban', ids.issuer);
    f.issuer.permissions.remove(PermissionFlagsBits.Administrator);
    await assert.rejects(resolveModerationAuthority(f.command, f.actorMember, f.channel, store), /原授權者已沒有管理員權限/);
    f.command.guild.ownerId = f.issuer.id;
    assert.equal((await resolveModerationAuthority(f.command, f.actorMember, f.channel, store)).authority, f.issuer);
  } finally { store.close(); }
});

test('a departed issuer disables the grant and transport errors never grant access', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('timeout');
    store.setGrant(ids.guild, ids.actor, 'timeout', ids.issuer);
    f.members.delete(ids.issuer);
    await assert.rejects(resolveModerationAuthority(f.command, f.actorMember, f.channel, store), /原授權者已離開伺服器/);
    const failure = { code: 50013 };
    f.state.fetchError = failure;
    await assert.rejects(resolveModerationAuthority(f.command, f.actorMember, f.channel, store), (error) => error === failure);
  } finally { store.close(); }
});

test('revocation is re-read on the next authority check', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('kick');
    store.setGrant(ids.guild, ids.actor, 'kick', ids.issuer);
    assert.equal((await resolveModerationAuthority(f.command, f.actorMember, f.channel, store)).delegated, true);
    store.revokeGrant(ids.guild, ids.actor, 'kick');
    await assert.rejects(resolveModerationAuthority(f.command, f.actorMember, f.channel, store), /沒有.*權限/);
    assert.equal(f.fetches.length, 1);
  } finally { store.close(); }
});

test('revocation or reassignment during issuer lookup cannot use stale authority', async () => {
  const store = new Store(':memory:');
  try {
    const revoked = fixture('ban');
    store.setGrant(ids.guild, ids.actor, 'ban', ids.issuer);
    revoked.state.onFetch = () => { store.revokeGrant(ids.guild, ids.actor, 'ban'); };
    await assert.rejects(resolveModerationAuthority(revoked.command, revoked.actorMember, revoked.channel, store), /授權已被撤回或變更/);

    const reassigned = fixture('ban');
    store.setGrant(ids.guild, ids.actor, 'ban', ids.issuer);
    reassigned.state.onFetch = () => { store.setGrant(ids.guild, ids.actor, 'ban', ids.owner); };
    await assert.rejects(resolveModerationAuthority(reassigned.command, reassigned.actorMember, reassigned.channel, store), /授權已被撤回或變更/);
  } finally { store.close(); }
});

test('clear uses effective channel permissions before falling back to a grant', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('clear');
    f.actor.permissions.add(PermissionFlagsBits.ManageMessages);
    await assert.rejects(resolveModerationAuthority(f.command, f.actorMember, f.channel, store), UserError);
    store.setGrant(ids.guild, ids.actor, 'clear', ids.issuer);
    assert.equal((await resolveModerationAuthority(f.command, f.actorMember, f.channel, store)).delegated, true);
    f.state.channelPermissions.add(PermissionFlagsBits.ManageMessages);
    assert.equal((await resolveModerationAuthority(f.command, f.actorMember, f.channel, store)).delegated, false);
  } finally { store.close(); }
});

test('delegated management and ManageGuild never permit issuing or reading grants', async () => {
  const store = new Store(':memory:');
  try {
    store.setGrants(ids.guild, ids.actor, [...MANAGEMENT_SCOPES], ids.issuer);
    const original = store.listGrants(ids.guild);
    for (const subcommand of ['grant', 'revoke', 'list']) {
      const f = fixture('access');
      f.state.subcommand = subcommand;
      f.actor.permissions.add(PermissionFlagsBits.ManageGuild);
      await assert.rejects(handleAccessCommand(f.command, store), /只有伺服器擁有者.*管理員/);
      assert.deepEqual(f.edits, []);
      assert.deepEqual(store.listGrants(ids.guild), original);
      assert.equal(store.listCases(ids.guild).length, 0);
    }
  } finally { store.close(); }
});

test('a native administrator can grant all five scopes atomically and writes an audit case', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('access');
    f.actor.permissions.add(PermissionFlagsBits.Administrator);
    f.state.scope = 'all';
    await handleAccessCommand(f.command, store);
    const grants = store.listGrants(ids.guild, ids.recipient);
    assert.deepEqual(grants.map((grant) => grant.scope).sort(), [...MANAGEMENT_SCOPES].sort());
    assert.ok(grants.every((grant) => grant.grantedBy === ids.actor));
    const audit = store.listCases(ids.guild)[0];
    assert.equal(audit?.action, 'access-grant');
    assert.equal(audit?.moderatorId, ids.actor);
    assert.equal(audit?.userId, ids.recipient);
    assert.match((f.edits.at(-1) as { content: string }).content, /已授權.*案件 #/s);
  } finally { store.close(); }
});

test('a grant cannot target a bot or complete after issuer permissions are revoked', async () => {
  const store = new Store(':memory:');
  try {
    const botTarget = fixture('access');
    botTarget.actor.permissions.add(PermissionFlagsBits.Administrator);
    botTarget.recipient.user.bot = true;
    await assert.rejects(handleAccessCommand(botTarget.command, store), /不能授權機器人/);
    assert.equal(store.listGrants(ids.guild).length, 0);

    const revoked = fixture('access');
    revoked.actor.permissions.add(PermissionFlagsBits.Administrator);
    revoked.state.onFetch = (id) => {
      if (id === ids.recipient) revoked.actor.permissions.remove(PermissionFlagsBits.Administrator);
    };
    await assert.rejects(handleAccessCommand(revoked.command, store), /只有伺服器擁有者/);
    assert.equal(store.listGrants(ids.guild).length, 0);
    assert.equal(store.listCases(ids.guild).length, 0);
  } finally { store.close(); }
});

test('revoking one scope or all scopes preserves grants in other guilds', async () => {
  const store = new Store(':memory:');
  try {
    store.setGrants(ids.guild, ids.recipient, [...MANAGEMENT_SCOPES], ids.issuer);
    store.setGrant(ids.otherGuild, ids.recipient, 'ban', ids.issuer);
    const f = fixture('access');
    f.actor.permissions.add(PermissionFlagsBits.Administrator);
    f.state.subcommand = 'revoke';
    f.state.scope = 'ban';
    await handleAccessCommand(f.command, store);
    assert.equal(store.getGrant(ids.guild, ids.recipient, 'ban'), null);
    assert.equal(store.listGrants(ids.guild, ids.recipient).length, 4);
    f.state.scope = null;
    await handleAccessCommand(f.command, store);
    assert.equal(store.listGrants(ids.guild).length, 0);
    assert.ok(store.getGrant(ids.otherGuild, ids.recipient, 'ban'));
    assert.equal(store.listCases(ids.guild).length, 2);
  } finally { store.close(); }
});

test('grant list is private to native admins and filters by selected user and current guild', async () => {
  const store = new Store(':memory:');
  try {
    store.setGrant(ids.guild, ids.recipient, 'warn', ids.issuer);
    store.setGrant(ids.guild, ids.actor, 'ban', ids.issuer);
    store.setGrant(ids.otherGuild, ids.recipient, 'clear', ids.issuer);
    const f = fixture('access');
    f.actor.permissions.add(PermissionFlagsBits.Administrator);
    f.state.subcommand = 'list';
    await handleAccessCommand(f.command, store);
    const reply = f.edits.at(-1) as { embeds: { toJSON(): { description?: string } }[]; allowedMentions: unknown };
    const description = reply.embeds[0]?.toJSON().description ?? '';
    assert.match(description, /警告與警告查詢/);
    assert.doesNotMatch(description, /封鎖與解除封鎖|清理訊息/);
    assert.deepEqual(reply.allowedMentions, { parse: [] });
    assert.equal(store.listCases(ids.guild).length, 0);
  } finally { store.close(); }
});

test('unknown scopes cannot create or revoke grants', async () => {
  const store = new Store(':memory:');
  try {
    const f = fixture('access');
    f.actor.permissions.add(PermissionFlagsBits.Administrator);
    f.state.scope = 'administrator';
    await assert.rejects(handleAccessCommand(f.command, store), /找不到此管理功能/);
    assert.equal(store.listGrants(ids.guild).length, 0);
    assert.equal(store.listCases(ids.guild).length, 0);
  } finally { store.close(); }
});
