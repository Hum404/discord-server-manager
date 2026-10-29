import { EmbedBuilder, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import { record } from './audit.js';
import { UserError } from './errors.js';
import { punishmentNoticeTarget } from './punishment-notices.js';
import { type GuildSettings, Store } from './store.js';

type Command = ChatInputCommandInteraction<'cached'>;
const noMentions = { parse: [] as never[] };

export function punishmentSettingsEmbed(settings: GuildSettings): EmbedBuilder {
  return new EmbedBuilder().setColor(0x5865f2).setTitle('本伺服器的處罰通知設定')
    .addFields(
      { name: '處罰公告', value: settings.punishmentNoticesEnabled ? '已啟用' : '已停用', inline: true },
      { name: '公告子區／頻道', value: settings.punishmentChannelId ? `<#${settings.punishmentChannelId}>` : '尚未設定', inline: true },
      { name: '處罰私訊與申訴入口', value: settings.punishmentDmEnabled ? '已啟用' : '已停用', inline: true },
      { name: '公告範圍', value: '僅伺服器處罰及解除處罰' },
      { name: '子區內管理通知', value: settings.subareaNoticesEnabled ? '已開啟；直接發送至操作的子區' : '已關閉' },
    ).setFooter({ text: '子區內通知預設開啟，由 /config subarea-notices 獨立設定。' });
}

/** Threads absent from the picker can be selected by their channel ID or same-guild URL. */
export function parsePunishmentChannel(value: string, guildId: string): string {
  const trimmed = value.trim();
  if (/^[0-9]{17,20}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || !['discord.com', 'www.discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname)
      || url.username || url.password || url.port) throw new Error('Unsupported URL');
    const path = /^\/channels\/([0-9]{17,20})\/([0-9]{17,20})(?:\/[0-9]{17,20})?\/?$/.exec(url.pathname);
    if (path?.[1] === guildId) return path[2]!;
  } catch { /* Report a single user-facing validation error below. */ }
  throw new UserError('請填寫 17 至 20 位頻道／討論串 ID，或本伺服器的 Discord 頻道連結。');
}

async function requireManager(command: Command): Promise<void> {
  await command.guild.roles.fetch();
  const actor = await command.guild.members.fetch({ user: command.user.id, force: true });
  if (actor.id !== command.guild.ownerId && !actor.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('只有具備原生「管理伺服器」權限的管理員可以設定或測試管理通知。');
  }
}

function unchanged(left: GuildSettings, right: GuildSettings): boolean {
  return left.punishmentChannelId === right.punishmentChannelId
    && left.punishmentNoticesEnabled === right.punishmentNoticesEnabled
    && left.punishmentDmEnabled === right.punishmentDmEnabled
    && left.subareaNoticesEnabled === right.subareaNoticesEnabled;
}

/** Local notifications have their own switch and never require an announcement destination. */
export async function handleSubareaNoticeConfig(command: Command, store: Store): Promise<void> {
  await requireManager(command);
  const enabled = command.options.getBoolean('enabled');
  const settings = enabled === null ? store.getSettings(command.guildId)
    : store.updateSettings(command.guildId, { subareaNoticesEnabled: enabled });
  const detail = `子區內管理通知已${settings.subareaNoticesEnabled ? '開啟' : '關閉'}。`;
  const suffix = enabled === null ? '' : await record(command, store, 'config', null, detail);
  await command.editReply({ content: detail + '\n通知直接發送至操作的子區；此開關只影響本伺服器。' + suffix,
    allowedMentions: noMentions });
}

/** Called after the root interaction handler has deferred an ephemeral reply. */
export async function handlePunishmentConfig(command: Command, store: Store): Promise<void> {
  await requireManager(command);
  const current = store.getSettings(command.guildId);
  if (command.options.getSubcommand() === 'punishment-test') {
    if (!current.punishmentNoticesEnabled || !current.punishmentChannelId) {
      throw new UserError('尚未啟用處罰公告；請先使用 /config punishments 設定通知子區。');
    }
    const channel = await punishmentNoticeTarget(command.guild, current.punishmentChannelId);
    await requireManager(command);
    if (!unchanged(current, store.getSettings(command.guildId))) {
      throw new UserError('處罰通知設定已變更，未發送測試；請重新執行。');
    }
    await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('處罰通知測試')
      .setDescription('此訊息僅用來確認處罰公告的發送位置及權限。未對任何成員執行處罰。')
      .addFields({ name: '測試管理員', value: `<@${command.user.id}>` })
      .setFooter({ text: '測試訊息，不會建立處罰案件。' }).setTimestamp()], allowedMentions: noMentions });
    await command.editReply({ content: `已將測試通知發送至 <#${channel.id}>。`, allowedMentions: noMentions });
    return;
  }

  const selected = command.options.getChannel('channel');
  const suppliedId = command.options.getString('channel-id');
  const enabled = command.options.getBoolean('enabled');
  const dm = command.options.getBoolean('dm');
  const includeSubareas = command.options.getBoolean('include-subareas');
  if (selected && suppliedId !== null) throw new UserError('channel 和 channel-id 請只填寫其中一項。');
  if (!selected && suppliedId === null && enabled === null && dm === null && includeSubareas === null) {
    await command.editReply({ embeds: [punishmentSettingsEmbed(current)], allowedMentions: noMentions });
    return;
  }
  const suppliedChannel = selected?.id ?? (suppliedId === null ? null : parsePunishmentChannel(suppliedId, command.guildId));
  const channelId = suppliedChannel ?? current.punishmentChannelId;
  const noticesEnabled = enabled ?? (suppliedChannel !== null ? true : current.punishmentNoticesEnabled);
  if (noticesEnabled && !channelId) throw new UserError('啟用處罰公告時，請先填寫通知的 channel 或 channel-id。');
  // DM-only changes and disabling notices remain possible even if an old destination was deleted.
  if (suppliedChannel || (enabled === true && channelId)) {
    await punishmentNoticeTarget(command.guild, channelId!);
  }
  await requireManager(command);
  if (!unchanged(current, store.getSettings(command.guildId))) {
    throw new UserError('其他管理員剛剛修改了處罰通知設定，請重新執行以免覆蓋。');
  }
  const settings = store.updateSettings(command.guildId, {
    ...(suppliedChannel === null ? {} : { punishmentChannelId: suppliedChannel }),
    ...(enabled === null && suppliedChannel === null ? {} : { punishmentNoticesEnabled: noticesEnabled }),
    ...(dm === null ? {} : { punishmentDmEnabled: dm }),
    ...(includeSubareas === null ? {} : { subareaNoticesEnabled: includeSubareas }),
  });
  const suffix = await record(command, store, 'config', null, '更新處罰通知設定',
    `公告 ${settings.punishmentNoticesEnabled ? '啟用' : '停用'}；目標 ${settings.punishmentChannelId ?? '未設定'}；私訊 ${settings.punishmentDmEnabled ? '啟用' : '停用'}；子區內管理通知 ${settings.subareaNoticesEnabled ? '開啟' : '關閉'}`);
  await command.editReply({ content: `已更新本伺服器的處罰通知設定。${suffix}`,
    embeds: [punishmentSettingsEmbed(settings)], allowedMentions: noMentions });
}
