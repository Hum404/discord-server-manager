import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  PermissionFlagsBits, escapeMarkdown,
  type ChatInputCommandInteraction, type Guild, type MessageContextMenuCommandInteraction,
  type NewsChannel, type TextChannel, type ThreadChannel,
} from 'discord.js';
import { SERVER_AUDIT_ACTIONS } from './audit-policy.js';
import { APPEALABLE_ACTIONS } from './domain.js';
import { logFailure, UserError } from './errors.js';
import { requireBotPermissions, requirePrivateThreadAccess } from './permissions.js';
import { truncate } from './presentation.js';
import type { GuildSettings, ModerationCase, Store } from './store.js';

type Command = ChatInputCommandInteraction<'cached'> | MessageContextMenuCommandInteraction<'cached'>;
type NoticeChannel = TextChannel | NewsChannel | ThreadChannel;

const serverActions = new Set<string>(SERVER_AUDIT_ACTIONS);
const subareaPunishments = new Set(['subarea-mute', 'subarea-unmute', 'subarea-kick', 'subarea-unkick']);
// Explicit actions only: ordinary mention commands already send their own notices.
const subareaManagement = new Set([
  'subarea-create', 'subarea-assign', 'subarea-delegate', 'subarea-undelegate',
  'subarea-pin', 'subarea-unpin', 'subarea-delete-message', 'subarea-slowmode',
  'subarea-rename', 'subarea-lock', 'subarea-unlock',
]);
const subareaActions = new Set([...subareaPunishments, ...subareaManagement]);
const reversalActions = new Set(['untimeout', 'unban', 'warning-remove', 'subarea-unmute', 'subarea-unkick']);
const actionLabels: Record<string, string> = {
  warn: '警告', timeout: '伺服器禁言', untimeout: '解除伺服器禁言', kick: '踢出伺服器',
  ban: '封鎖', unban: '解除封鎖', 'warning-remove': '撤銷警告',
  'subarea-mute': '子區禁言', 'subarea-unmute': '解除子區禁言',
  'subarea-kick': '子區移除', 'subarea-unkick': '解除子區移除',
  'subarea-create': '建立子區', 'subarea-assign': '指派子區建立者',
  'subarea-delegate': '授予子區協管', 'subarea-undelegate': '撤回子區協管',
  'subarea-pin': '子區訊息置頂', 'subarea-unpin': '取消子區置頂',
  'subarea-delete-message': '刪除子區訊息', 'subarea-slowmode': '調整子區慢速模式',
  'subarea-rename': '修改子區名稱', 'subarea-lock': '鎖定子區',
  'subarea-unlock': '解鎖子區', 'subarea-delete': '刪除子區',
};

function isThread(channel: NoticeChannel): channel is ThreadChannel {
  return channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread
    || channel.type === ChannelType.AnnouncementThread;
}

/** Resolve an explicit same-guild destination without joining or reopening any thread. */
export async function punishmentNoticeTarget(guild: Guild, channelId: string): Promise<NoticeChannel> {
  await guild.roles.fetch();
  const [channel, bot] = await Promise.all([
    guild.channels.fetch(channelId, { force: true }),
    guild.members.fetchMe({ force: true }),
  ]);
  if (!channel || channel.id !== channelId || channel.guildId !== guild.id
    || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement
      && channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread
      && channel.type !== ChannelType.AnnouncementThread)) {
    throw new UserError('處罰通知必須使用本伺服器的文字頻道、公告頻道或實際的討論串／論壇帖子。');
  }
  if (isThread(channel)) {
    if (channel.archived || channel.locked) throw new UserError('處罰通知的討論串已封存或鎖定，請先解除或改用其他子區。');
    const accessError = await requirePrivateThreadAccess(channel, bot);
    if (accessError) throw new UserError('機器人不是這個私密討論串的成員，無法傳送處罰通知。');
  }
  // Private membership lookup can yield; evaluate current permissions afterward.
  const permissionError = requireBotPermissions(bot, channel, [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks,
    isThread(channel) ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
  ]);
  if (permissionError) throw new UserError(permissionError);
  if (isThread(channel) && (channel.archived || channel.locked)) {
    throw new UserError('處罰通知的討論串已封存或鎖定，請先解除或改用其他子區。');
  }
  return channel;
}

function shouldSend(settings: GuildSettings, entry: ModerationCase): boolean {
  if (subareaActions.has(entry.action)) return settings.subareaNoticesEnabled;
  return serverActions.has(entry.action) && settings.punishmentNoticesEnabled && settings.punishmentChannelId !== null;
}

/** Called only after the operation and its local case have both been saved. */
export async function deliverPunishmentNotice(
  command: Command, store: Store, entry: ModerationCase,
): Promise<{ sentChannelId: string | null; warning: string }> {
  const skipped = { sentChannelId: null, warning: '' };
  // Unrelated member operations must never consult or publish to notification settings.
  if ((!serverActions.has(entry.action) && !subareaActions.has(entry.action))
    || (serverActions.has(entry.action) && entry.userId === null)
    || (subareaActions.has(entry.action) && entry.channelId === null)) return skipped;
  try {
    if (entry.guildId !== command.guildId || command.guild.id !== command.guildId) {
      throw new UserError('處罰通知的伺服器不符。');
    }
    const settings = store.getSettings(command.guildId);
    if (!shouldSend(settings, entry)) return skipped;
    const local = subareaActions.has(entry.action);
    // The persisted operation target remains authoritative during outside-channel recovery.
    // Child notices never fall back to the configured server announcement destination.
    const destinationId = local ? entry.channelId! : settings.punishmentChannelId!;
    const channel = await punishmentNoticeTarget(command.guild, destinationId);
    const management = subareaManagement.has(entry.action);
    const embed = new EmbedBuilder()
      .setColor(management ? 0x5865f2 : reversalActions.has(entry.action) ? 0x23a55a : 0xf0b232)
      .setTitle(`${management ? '子區管理通知' : reversalActions.has(entry.action) ? '處罰解除通知' : '處罰通知'} · ${actionLabels[entry.action]}`)
      .addFields(
        { name: local ? '成員紀錄編號' : '案件編號', value: `#${entry.caseNumber}`, inline: true },
        { name: '影響範圍', value: local ? '僅指定子區' : '整個伺服器', inline: true },
        { name: entry.userId ? '成員' : '操作對象', value: entry.userId
          ? `<@${entry.userId}>（${entry.userId}）` : entry.channelId ? `<#${entry.channelId}>` : '子區' },
        { name: '執行者', value: `<@${entry.moderatorId}>（${entry.moderatorId}）` },
        { name: '原因', value: truncate(escapeMarkdown(entry.reason), 1024) },
      ).setTimestamp(new Date(entry.createdAt));
    if (entry.channelId && (!management || entry.userId)) embed.addFields({
      name: local ? management ? '操作子區' : '處罰子區' : '操作所在頻道', value: `<#${entry.channelId}>`,
    });
    if (entry.details) embed.addFields({ name: entry.action === 'timeout' ? '禁言時長' : '詳細內容', value: truncate(escapeMarkdown(entry.details), 1024) });
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (entry.userId && APPEALABLE_ACTIONS.has(entry.action)) {
      embed.setFooter({ text: '僅處罰對象可使用申訴按鈕；請核對案件編號。' });
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
        .setCustomId(`appeal:case:${entry.guildId}:${entry.caseNumber}:${entry.userId}`)
        .setLabel('提交申訴').setStyle(ButtonStyle.Primary)));
    }
    // Fetches above yield to commands disabling local notices or changing the server destination.
    const current = store.getSettings(command.guildId);
    if (!shouldSend(current, entry) || (!local && current.punishmentChannelId !== settings.punishmentChannelId)) return skipped;
    await channel.send({ embeds: [embed], components, allowedMentions: { parse: [] } });
    return { sentChannelId: channel.id, warning: '' };
  } catch (error) {
    const management = subareaManagement.has(entry.action);
    logFailure(management ? '子區管理通知發送失敗' : '處罰通知發送失敗', error);
    return { sentChannelId: null, warning: management
      ? '\n⚠️ 子區管理通知發送失敗；操作已完成，成員紀錄已保留。'
      : '\n⚠️ 處罰通知發送失敗；處罰與本機案件紀錄已保留。' };
  }
}
