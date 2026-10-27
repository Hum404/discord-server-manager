import { OverwriteType, PermissionFlagsBits, type GuildMember, type TextChannel } from 'discord.js';
import { UserError } from './errors.js';

const privacyError = '申訴頻道可被非管理人員查看，請建立僅供管理員與機器人使用的私人文字頻道。';

function staff(member: GuildMember): boolean {
  return member.id === member.guild.ownerId
    || member.permissions.has(PermissionFlagsBits.ManageGuild)
    || member.permissions.has(PermissionFlagsBits.Administrator);
}

/** Everyone-denied alone is insufficient: another role or member may allow access. */
export async function assertPrivateAppealChannel(channel: TextChannel, botId: string): Promise<void> {
  const guild = channel.guild;
  const everyonePermissions = channel.permissionsFor(guild.roles.everyone);
  if (!everyonePermissions || everyonePermissions.has(PermissionFlagsBits.ViewChannel)) {
    throw new UserError(privacyError);
  }
  for (const role of guild.roles.cache.values()) {
    if (role.tags?.botId === botId || role.permissions.has(PermissionFlagsBits.Administrator)
      || role.permissions.has(PermissionFlagsBits.ManageGuild)) continue;
    const permissions = channel.permissionsFor(role);
    if (!permissions || permissions.has(PermissionFlagsBits.ViewChannel)) throw new UserError(privacyError);
  }
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (overwrite.type !== OverwriteType.Member || overwrite.id === botId || overwrite.id === guild.ownerId) continue;
    let member: GuildMember;
    try {
      member = await guild.members.fetch({ user: overwrite.id, force: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 10007) {
        if (overwrite.allow.has(PermissionFlagsBits.ViewChannel)) throw new UserError(privacyError);
        continue;
      }
      throw error;
    }
    const permissions = channel.permissionsFor(member);
    if (!permissions || (permissions.has(PermissionFlagsBits.ViewChannel) && !staff(member))) {
      throw new UserError(privacyError);
    }
  }
}
