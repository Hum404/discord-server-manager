import { ChannelType, EmbedBuilder, escapeMarkdown, type ChatInputCommandInteraction } from 'discord.js';
import { logFailure, UserError } from './errors.js';
import { truncate } from './presentation.js';
import type { Store } from './store.js';

const actionLabels: Record<string, string> = {
  warn: '警告', timeout: '禁言', untimeout: '解除禁言', kick: '踢出',
  ban: '封鎖', unban: '解除封鎖', clear: '清理訊息', config: '更新設定',
  'access-grant': '管理授權', 'access-revoke': '撤回授權',
  'subarea-create': '建立子區', 'subarea-assign': '指派子區建立者',
  'subarea-mute': '子區禁言', 'subarea-unmute': '解除子區禁言',
  'subarea-kick': '子區移除', 'subarea-unkick': '解除子區移除',
};

export async function record(
  command: ChatInputCommandInteraction<'cached'>, store: Store,
  action: string, userId: string | null, reason: string, details?: string,
): Promise<string> {
  let recordId: number;
  try {
    recordId = store.addCase({ guildId: command.guildId, action, userId,
      moderatorId: command.user.id, reason, details }).id;
  } catch (error) {
    logFailure('操作完成，但本機管理紀錄寫入失敗', error);
    return '\n⚠️ 操作已完成，但本機管理紀錄寫入失敗，請檢查儲存空間。';
  }
  const suffix = `\n案件 #${recordId}`;
  try {
    const settings = store.getSettings(command.guildId);
    if (!settings.logChannelId) return suffix;
    const channel = await command.guild.channels.fetch(settings.logChannelId);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      throw new UserError('管理紀錄頻道已不存在。');
    }
    const embed = new EmbedBuilder().setColor(0x5865f2)
      .setTitle(`案件 #${recordId} · ${actionLabels[action] ?? action}`)
      .addFields(
        { name: '執行者', value: `<@${command.user.id}>（${command.user.id}）` },
        { name: '對象', value: userId ? `<@${userId}>（${userId}）` : `<#${command.channelId}>` },
        { name: '原因', value: truncate(escapeMarkdown(reason), 1024) },
      ).setTimestamp();
    if (details) embed.addFields({ name: '詳細內容', value: truncate(escapeMarkdown(details), 1024) });
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return suffix;
  } catch (error) {
    logFailure('管理紀錄頻道發送失敗', error);
    return `${suffix}\n⚠️ 紀錄頻道發送失敗；案件已保存在本機。`;
  }
}
