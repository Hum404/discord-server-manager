import { ChannelType, EmbedBuilder, escapeMarkdown, type ChatInputCommandInteraction, type MessageContextMenuCommandInteraction } from 'discord.js';
import { logFailure, UserError } from './errors.js';
import { truncate } from './presentation.js';
import type { ModerationCase, Store } from './store.js';
import { deliverPunishmentNotice } from './punishment-notices.js';

const actionLabels: Record<string, string> = {
  warn: '警告', timeout: '禁言', untimeout: '解除禁言', kick: '踢出',
  ban: '封鎖', unban: '解除封鎖', clear: '清理訊息', config: '更新設定',
  'access-grant': '管理授權', 'access-revoke': '撤回授權',
  'subarea-create': '建立子區', 'subarea-assign': '指派子區建立者',
  'subarea-mute': '子區禁言', 'subarea-unmute': '解除子區禁言',
  'subarea-kick': '子區移除', 'subarea-unkick': '解除子區移除',
  'subarea-pin': '子區訊息置頂', 'subarea-unpin': '取消子區置頂',
  'subarea-delete-message': '刪除子區訊息', 'subarea-slowmode': '調整子區慢速模式',
  'subarea-rename': '修改子區名稱', 'subarea-lock': '鎖定子區', 'subarea-unlock': '解鎖子區',
  'subarea-delete': '刪除子區', 'subarea-delegate': '授予子區協管', 'subarea-undelegate': '撤回子區協管',
  'subarea-tag': '子區提及通知', 'subarea-role-tag': '子區身分組通知', 'subarea-announce': '子區全體通知',
  'warning-remove': '撤銷警告', 'role-add': '新增身分組', 'role-remove': '移除身分組',
  'channel-edit': '編輯頻道',
  'message-pin': '置頂訊息', 'message-unpin': '取消置頂訊息', 'message-delete': '刪除訊息',
};

export async function record(
  command: ChatInputCommandInteraction<'cached'> | MessageContextMenuCommandInteraction<'cached'>, store: Store,
  action: string, userId: string | null, reason: string, details?: string,
  targetChannelId?: string,
): Promise<string> {
  let entry: ModerationCase;
  try {
    entry = store.addCase({ guildId: command.guildId, action, userId,
      moderatorId: command.user.id, reason, details, channelId: targetChannelId ?? command.channelId });
  } catch (error) {
    logFailure('操作完成，但本機管理紀錄寫入失敗', error);
    return '\n⚠️ 操作已完成，但本機管理紀錄寫入失敗，請檢查儲存空間。';
  }
  // Member activity stays in the private ledger, even when a server log is configured.
  const notice = await deliverPunishmentNotice(command, store, entry);
  const suffix = (entry.scope === 'server' ? `\n本服案件 #${entry.caseNumber}` : `\n成員紀錄 #${entry.caseNumber}`) + notice.warning;
  if (entry.scope !== 'server') return suffix;
  try {
    const settings = store.getSettings(command.guildId);
    if (!settings.logChannelId || settings.logChannelId === notice.sentChannelId) return suffix;
    const channel = await command.guild.channels.fetch(settings.logChannelId);
    if (!channel || channel.guildId !== command.guildId
      || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      throw new UserError('本伺服器的管理紀錄頻道已不存在或設定不符。');
    }
    const embed = new EmbedBuilder().setColor(0x5865f2)
      .setTitle(`本服案件 #${entry.caseNumber} · ${actionLabels[action] ?? action}`)
      .addFields(
        { name: '執行者', value: `<@${command.user.id}>（${command.user.id}）` },
        { name: '對象', value: userId ? `<@${userId}>（${userId}）` : `<#${targetChannelId ?? command.channelId}>` },
        { name: '原因', value: truncate(escapeMarkdown(reason), 1024) },
      ).setTimestamp();
    if (details) embed.addFields({ name: '詳細內容', value: truncate(escapeMarkdown(details), 1024) });
    // A channel lookup yields to other commands; honor a disabled or changed log setting.
    if (store.getSettings(command.guildId).logChannelId !== settings.logChannelId) return suffix;
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return suffix;
  } catch (error) {
    logFailure('管理紀錄頻道發送失敗', error);
    return `${suffix}\n⚠️ 紀錄頻道發送失敗；案件已保存在本機。`;
  }
}
