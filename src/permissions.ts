import { ChannelType, PermissionFlagsBits, type GuildBasedChannel, type GuildMember } from 'discord.js';

export type ModerationAction = 'warn' | 'timeout' | 'untimeout' | 'kick' | 'ban';

export interface ModerationTargetContext {
  actorId: string;
  actorHighestPosition: number;
  actorIsOwner: boolean;
  targetId: string;
  targetHighestPosition: number;
  targetIsOwner: boolean;
  botId: string;
  botHighestPosition: number;
  action: ModerationAction;
  targetIsBot: boolean;
  targetIsAdministrator: boolean;
}

/** Returns a user-facing reason when the target is protected. */
export function checkModerationTarget(context: ModerationTargetContext): string | null {
  if (context.targetId === context.actorId) return '無法對自己執行此管理操作。';
  if (context.targetId === context.botId) return '無法對本機器人執行此管理操作。';
  if (context.targetIsOwner) return '無法對伺服器擁有者執行此管理操作。';
  if (!context.actorIsOwner && context.targetHighestPosition >= context.actorHighestPosition) {
    return '你的最高角色必須高於目標成員的最高角色。';
  }
  // Warnings only write a local record and do not require a Discord role edit.
  if (context.action !== 'warn' && context.targetHighestPosition >= context.botHighestPosition) {
    return '機器人的最高角色必須高於目標成員的最高角色。';
  }
  if ((context.action === 'timeout' || context.action === 'untimeout') && context.targetIsBot) {
    return '機器人成員無法被禁言或解除禁言。';
  }
  if (context.action === 'timeout' && context.targetIsAdministrator) {
    return '擁有管理員權限的成員無法被禁言。';
  }
  return null;
}

const permissionNames = new Map<bigint, string>([
  [PermissionFlagsBits.ViewChannel, '查看頻道'],
  [PermissionFlagsBits.SendMessages, '傳送訊息'],
  [PermissionFlagsBits.SendMessagesInThreads, '在討論串傳送訊息'],
  [PermissionFlagsBits.ReadMessageHistory, '讀取訊息歷史'],
  [PermissionFlagsBits.EmbedLinks, '嵌入連結'],
  [PermissionFlagsBits.ManageMessages, '管理訊息'],
  [PermissionFlagsBits.ModerateMembers, '禁言成員'],
  [PermissionFlagsBits.KickMembers, '踢出成員'],
  [PermissionFlagsBits.BanMembers, '封鎖成員'],
  [PermissionFlagsBits.ManageGuild, '管理伺服器'],
  [PermissionFlagsBits.ManageChannels, '管理頻道'],
  [PermissionFlagsBits.ManageRoles, '管理身分組與頻道權限'],
  [PermissionFlagsBits.ManageThreads, '管理討論串'],
  [PermissionFlagsBits.CreatePublicThreads, '建立公開討論串'],
  [PermissionFlagsBits.CreatePrivateThreads, '建立私密討論串'],
  [PermissionFlagsBits.AddReactions, '新增反應'],
  [PermissionFlagsBits.MentionEveryone, '提及 everyone／here 和身分組'],
  [PermissionFlagsBits.PinMessages, '置頂訊息'],
]);

/** Thread permissions inherit the parent's bitfield; private membership is a separate access check. */
export async function requirePrivateThreadAccess(channel: GuildBasedChannel, actor: GuildMember): Promise<string | null> {
  if (channel.type !== ChannelType.PrivateThread || actor.id === channel.guild.ownerId
    || channel.permissionsFor(actor)?.has(PermissionFlagsBits.ManageThreads)) return null;
  try {
    await channel.members.fetch({ member: actor.id, force: true, cache: false });
    return null;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error
      && [10007, 10013, 50001, 50013].includes(Number(error.code))) {
      return '你目前不是這個私密討論串的成員，無法使用此子區的管理功能。';
    }
    throw error;
  }
}

export function requireBotPermissions(
  bot: GuildMember,
  channel: GuildBasedChannel | null,
  required: bigint[],
): string | null {
  const permissions = channel ? channel.permissionsFor(bot) : bot.permissions;
  const missing = required.filter((permission) => !permissions?.has(permission));
  if (missing.length === 0) return null;
  return `機器人缺少以下權限：${missing.map((permission) =>
    permissionNames.get(permission) ?? `權限 ${permission.toString()}`).join('、')}。`;
}
