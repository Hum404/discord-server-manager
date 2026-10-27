import {
  EmbedBuilder, PermissionFlagsBits,
  type ChatInputCommandInteraction, type GuildBasedChannel, type GuildMember,
} from 'discord.js';
import { record } from './audit.js';
import { permissionForCommand } from './commands.js';
import { MANAGEMENT_SCOPES, SCOPE_LABELS, scopeForCommand, type ManagementScope } from './domain.js';
import { UserError } from './errors.js';
import { truncate } from './presentation.js';
import { Store } from './store.js';

type Command = ChatInputCommandInteraction<'cached'>;

export interface ModerationAuthority {
  authority: GuildMember;
  delegated: boolean;
}

function nativeAdministrator(actor: GuildMember, ownerId: string): boolean {
  return actor.id === ownerId || actor.permissions.has(PermissionFlagsBits.Administrator);
}

/** A grant borrows its issuer's current authority, never the recipient's role rank. */
export async function resolveModerationAuthority(
  command: Command,
  actor: GuildMember,
  channel: GuildBasedChannel | null,
  store: Store,
): Promise<ModerationAuthority> {
  const required = command.commandName === 'access'
    ? PermissionFlagsBits.Administrator : permissionForCommand(command.commandName);
  if (required === null || nativeAdministrator(actor, command.guild.ownerId)) {
    return { authority: actor, delegated: false };
  }
  const permissions = command.commandName === 'clear' ? channel?.permissionsFor(actor) : actor.permissions;
  if (permissions?.has(required)) return { authority: actor, delegated: false };

  const scope = scopeForCommand(command.commandName);
  const grant = scope ? store.getGrant(command.guildId, actor.id, scope) : null;
  if (!scope || !grant) throw new UserError('你目前沒有執行此指令所需的權限或管理授權。');

  let issuer: GuildMember;
  try {
    issuer = await command.guild.members.fetch({ user: grant.grantedBy, force: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 10007) {
      throw new UserError('原授權者已離開伺服器，請管理員重新授權。');
    }
    throw error;
  }
  const currentGrant = store.getGrant(command.guildId, actor.id, scope);
  if (!currentGrant || currentGrant.grantedBy !== grant.grantedBy) {
    throw new UserError('管理授權已被撤回或變更，未執行操作。');
  }
  if (!nativeAdministrator(issuer, command.guild.ownerId)) {
    throw new UserError('原授權者已沒有管理員權限，此管理授權目前無效。');
  }
  return { authority: issuer, delegated: true };
}

function requestedScopes(value: string | null): ManagementScope[] {
  if (value === null || value === 'all') return [...MANAGEMENT_SCOPES];
  if (!MANAGEMENT_SCOPES.some((scope) => scope === value)) {
    throw new UserError('找不到此管理功能，請重新選擇授權範圍。');
  }
  return [value as ManagementScope];
}

async function refreshAccessManager(command: Command): Promise<GuildMember> {
  await command.guild.roles.fetch();
  const actor = await command.guild.members.fetch({ user: command.user.id, force: true });
  if (!nativeAdministrator(actor, command.guild.ownerId)) {
    throw new UserError('只有伺服器擁有者或擁有 Discord 管理員權限的人可以管理授權。');
  }
  return actor;
}

/** Called only after an ephemeral defer; all grant administration is native-admin only. */
export async function handleAccessCommand(command: Command, store: Store): Promise<void> {
  let actor = await refreshAccessManager(command);
  const subcommand = command.options.getSubcommand();
  if (subcommand === 'list') {
    const user = command.options.getUser('user');
    const grants = store.listGrants(command.guildId, user?.id);
    const lines = grants.map((grant) =>
      `<@${grant.userId}> · ${SCOPE_LABELS[grant.scope]} · 授權者 <@${grant.grantedBy}>`,
    );
    await command.editReply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('管理功能授權')
        .setDescription(lines.length ? truncate(lines.join('\n'), 3800) : '尚無管理功能授權。')
        .setFooter({ text: '撤回授權不會移除用戶原本的 Discord 身分組權限。' })],
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (subcommand !== 'grant' && subcommand !== 'revoke') {
    throw new UserError('找不到此授權操作，請重新選擇指令。');
  }
  const user = command.options.getUser('user', true);
  const scopes = requestedScopes(command.options.getString('scope'));
  const labels = scopes.map((scope) => SCOPE_LABELS[scope]).join('、');
  let result: string;
  if (subcommand === 'grant') {
    const recipient = await command.guild.members.fetch({ user: user.id, force: true });
    if (recipient.user.bot) throw new UserError('只能授權伺服器內的用戶，不能授權機器人。');
    // Member lookup awaited Discord; do not issue a grant using a revoked admin role.
    actor = await refreshAccessManager(command);
    store.setGrants(command.guildId, user.id, scopes, actor.id);
    result = `已授權 <@${user.id}> 使用：${labels}。`;
  } else {
    const removed = scopes.length === MANAGEMENT_SCOPES.length
      ? store.revokeGrant(command.guildId, user.id)
      : store.revokeGrant(command.guildId, user.id, scopes[0]!);
    result = `已撤回 <@${user.id}> 的管理授權：${labels}（${removed} 項）。`;
  }
  const suffix = await record(command, store, `access-${subcommand}`, user.id,
    subcommand === 'grant' ? `授予管理功能：${labels}` : `撤回管理功能：${labels}`);
  await command.editReply({ content: result + suffix, allowedMentions: { parse: [] } });
}
