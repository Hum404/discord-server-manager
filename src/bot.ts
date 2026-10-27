import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType,
  EmbedBuilder, MessageFlags, PermissionFlagsBits, escapeMarkdown,
  type ChatInputCommandInteraction, type GuildBasedChannel,
  type GuildMember, type Interaction, type NewsChannel, type TextChannel,
} from 'discord.js';
import { permissionForCommand } from './commands.js';
import { checkModerationTarget, requireBotPermissions, type ModerationAction } from './permissions.js';
import { formatWelcome, recentMessageIds, truncate } from './presentation.js';
import { Store } from './store.js';

class UserError extends Error {}
type Command = ChatInputCommandInteraction<'cached'>;
type Context = { actor: GuildMember; bot: GuildMember; channel: GuildBasedChannel | null };
const noMentions = { parse: [] as never[] };
const actionLabels: Record<string, string> = {
  warn: '警告', timeout: '禁言', untimeout: '解除禁言', kick: '踢出',
  ban: '封鎖', unban: '解除封鎖', clear: '清理訊息', config: '更新設定',
};

/** Only log error codes: REST errors may otherwise include request credentials. */
export function logFailure(context: string, error: unknown): void {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const safeCode = typeof code === 'number' || (typeof code === 'string' && /^[A-Z_0-9]{1,50}$/.test(code))
    ? String(code) : 'UNKNOWN';
  console.error(`${context}（代碼：${safeCode}）`);
}

function errorMessage(error: unknown): string {
  if (error instanceof UserError) return error.message;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 50013: return 'Discord 拒絕操作：請檢查機器人權限及角色階級。';
    case 50001: return '機器人無法存取此頻道或伺服器，請檢查權限。';
    case 10007: return '找不到此成員，對方可能已離開伺服器。';
    case 10026: return '此使用者不在封鎖名單中。';
    case 10003: return '找不到此頻道，請重新設定。';
    default: return '操作未能完成，請稍後再試；若涉及成員異動，請先檢查目前狀態。';
  }
}

function assertPermissions(error: string | null): void {
  if (error) throw new UserError(error);
}

async function getContext(command: Command): Promise<Context> {
  // Refresh roles and members, including after a confirmation, to honor permission changes.
  await command.guild.roles.fetch();
  const [actor, bot, channel] = await Promise.all([
    command.guild.members.fetch({ user: command.user.id, force: true }),
    command.guild.members.fetchMe({ force: true }),
    command.guild.channels.fetch(command.channelId, { force: true }),
  ]);
  const permission = permissionForCommand(command.commandName);
  const actorPermissions = command.commandName === 'clear'
    ? channel?.permissionsFor(actor) : actor.permissions;
  if (permission !== null && !actorPermissions?.has(permission)) {
    throw new UserError('你目前沒有執行此指令所需的權限。');
  }
  return { actor, bot, channel };
}

async function getTarget(command: Command, context: Context, action: ModerationAction): Promise<GuildMember> {
  const user = command.options.getUser('user', true);
  const target = await command.guild.members.fetch({ user: user.id, force: true });
  assertPermissions(checkModerationTarget({
    actorId: context.actor.id,
    actorHighestPosition: context.actor.roles.highest.position,
    actorIsOwner: command.guild.ownerId === context.actor.id,
    targetId: target.id,
    targetHighestPosition: target.roles.highest.position,
    targetIsOwner: command.guild.ownerId === target.id,
    botId: context.bot.id,
    botHighestPosition: context.bot.roles.highest.position,
    action,
    targetIsBot: target.user.bot,
    targetIsAdministrator: target.permissions.has(PermissionFlagsBits.Administrator),
  }));
  if (action !== 'warn') {
    const required = action === 'kick' ? PermissionFlagsBits.KickMembers
      : action === 'ban' ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.ModerateMembers;
    assertPermissions(requireBotPermissions(context.bot, null, [required]));
    // Discord's comparison also handles the ordering of equal-position roles.
    if ((action === 'kick' && !target.kickable) || (action === 'ban' && !target.bannable)
      || ((action === 'timeout' || action === 'untimeout') && !target.manageable)) {
      throw new UserError('機器人的角色階級不足，無法管理此成員。');
    }
  }
  return target;
}

function reasonFor(command: Command): string {
  const reason = command.options.getString('reason', true).trim();
  if (!reason) throw new UserError('請填寫管理原因。');
  return reason;
}

function auditReason(command: Command, reason: string): string {
  // Audit-log reasons have a 512 character limit, including the acting moderator.
  return truncate(`${command.user.id}：${reason}`, 512);
}

async function confirm(command: Command, prompt: string): Promise<boolean> {
  const yes = `confirm:${command.id}`;
  const no = `cancel:${command.id}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(yes).setLabel('確認執行').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(no).setLabel('取消').setStyle(ButtonStyle.Secondary),
  );
  const message = await command.editReply({
    content: `${prompt}\n請在 30 秒內確認。`, embeds: [], components: [row], allowedMentions: noMentions,
  });
  let button;
  try {
    button = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 30_000,
      filter: (interaction) => interaction.user.id === command.user.id
        && (interaction.customId === yes || interaction.customId === no),
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'InteractionCollectorError') {
      await command.editReply({ content: '確認已逾時，未執行操作。', components: [] });
      return false;
    }
    throw error;
  }
  const accepted = button.customId === yes;
  await button.update({ content: accepted ? '正在執行…' : '已取消操作。', components: [] });
  return accepted;
}

function textChannel(channel: GuildBasedChannel | null): TextChannel | NewsChannel {
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    throw new UserError('請在伺服器的文字頻道或公告頻道使用此功能。');
  }
  return channel;
}

async function record(
  command: Command, store: Store, action: string, userId: string | null, reason: string, details?: string,
): Promise<string> {
  let recordId: number;
  try {
    recordId = store.addCase({
      guildId: command.guildId, action, userId, moderatorId: command.user.id, reason, details,
    }).id;
  } catch (error) {
    logFailure('操作完成，但本機管理紀錄寫入失敗', error);
    return '\n⚠️ 操作已完成，但本機管理紀錄寫入失敗，請檢查儲存空間。';
  }
  const suffix = `\n案件 #${recordId}`;
  try {
    const settings = store.getSettings(command.guildId);
    if (!settings.logChannelId) return suffix;
    const channel = textChannel(await command.guild.channels.fetch(settings.logChannelId));
    const embed = new EmbedBuilder().setColor(0x5865f2)
      .setTitle(`案件 #${recordId} · ${actionLabels[action] ?? action}`)
      .addFields(
        { name: '執行者', value: `<@${command.user.id}>（${command.user.id}）` },
        { name: '對象', value: userId ? `<@${userId}>（${userId}）` : `<#${command.channelId}>` },
        { name: '原因', value: escapeMarkdown(reason) },
      ).setTimestamp();
    if (details) embed.addFields({ name: '詳細內容', value: truncate(escapeMarkdown(details), 1024) });
    await channel.send({ embeds: [embed], allowedMentions: noMentions });
    return suffix;
  } catch (error) {
    logFailure('管理紀錄頻道發送失敗', error);
    return `${suffix}\n⚠️ 紀錄頻道發送失敗；案件已保存在本機。`;
  }
}

async function configure(command: Command, context: Context, store: Store): Promise<void> {
  const subcommand = command.options.getSubcommand();
  const settings = store.getSettings(command.guildId);
  if (subcommand === 'view') {
    await command.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('伺服器設定')
      .addFields(
        { name: '管理紀錄頻道', value: settings.logChannelId ? `<#${settings.logChannelId}>` : '未啟用' },
        { name: '歡迎頻道', value: settings.welcomeChannelId ? `<#${settings.welcomeChannelId}>` : '未啟用' },
        { name: '歡迎內容', value: truncate(escapeMarkdown(settings.welcomeMessage), 1024) },
      )], allowedMentions: noMentions });
    return;
  }
  let detail: string;
  if (subcommand === 'welcome-message') {
    const message = command.options.getString('message', true).trim();
    if (!message) throw new UserError('歡迎訊息不能為空白。');
    store.updateSettings(command.guildId, { welcomeMessage: message });
    detail = '已更新歡迎訊息範本。';
  } else if (subcommand === 'logs' || subcommand === 'welcome') {
    const selected = command.options.getChannel('channel');
    if (selected) {
      const channel = textChannel(await command.guild.channels.fetch(selected.id, { force: true }));
      assertPermissions(requireBotPermissions(context.bot, channel, [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        ...(subcommand === 'logs' ? [PermissionFlagsBits.EmbedLinks] : []),
      ]));
    }
    store.updateSettings(command.guildId, subcommand === 'logs'
      ? { logChannelId: selected?.id ?? null } : { welcomeChannelId: selected?.id ?? null });
    detail = selected ? `已設定${subcommand === 'logs' ? '管理紀錄' : '歡迎'}頻道為 <#${selected.id}>。`
      : `已停用${subcommand === 'logs' ? '管理紀錄頻道' : '歡迎訊息'}。`;
  } else {
    throw new UserError('找不到此設定項目，請重新註冊指令。');
  }
  const suffix = await record(command, store, 'config', null, detail);
  await command.editReply({ content: detail + suffix, allowedMentions: noMentions });
}

async function run(command: Command, store: Store): Promise<void> {
  if (command.commandName === 'help') {
    await command.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('伺服器管理助手')
      .setDescription('以 Slash 指令管理伺服器。管理操作會檢查權限與角色階級，並留下案件紀錄。')
      .addFields(
        { name: '一般', value: '`/help` 指令說明\n`/ping` 連線狀態' },
        { name: '成員管理', value: '`/warn` 新增警告\n`/warnings` 最近 10 筆警告\n`/timeout` 禁言（最長 28 天）\n`/untimeout` 解除禁言\n`/kick` 踢出\n`/ban` 封鎖\n`/unban` 以 ID 解除封鎖' },
        { name: '頻道與設定', value: '`/clear` 清理最近訊息（最多 100 則）\n`/config view` 查看設定\n`/config logs` 管理紀錄頻道\n`/config welcome` 歡迎頻道\n`/config welcome-message` 歡迎內容' },
        { name: '使用提醒', value: '踢出、封鎖、清理訊息須在 30 秒內確認。歡迎內容支援 `{user}`、`{server}`、`{count}`。設定頻道時留空可停用。' },
      )] });
    return;
  }
  if (command.commandName === 'ping') {
    await command.editReply(`機器人運作中。Gateway 延遲：${command.client.ws.ping < 0 ? '計算中' : `${command.client.ws.ping} ms`}。`);
    return;
  }
  let context = await getContext(command);
  if (command.commandName === 'config') return configure(command, context, store);
  if (command.commandName === 'warnings') {
    const user = command.options.getUser('user', true);
    const warnings = store.listWarnings(command.guildId, user.id, 10);
    const total = store.countWarnings(command.guildId, user.id);
    await command.editReply({ embeds: [new EmbedBuilder().setColor(0xf0b232)
      .setTitle(`${truncate(user.username, 80)} 的警告紀錄`)
      .setDescription(warnings.length ? warnings.map((warning) =>
        `**#${warning.id}** · <t:${Math.floor(Date.parse(warning.createdAt) / 1000)}:d> · <@${warning.moderatorId}>\n${truncate(escapeMarkdown(warning.reason), 200)}`,
      ).join('\n\n') : '此成員尚無警告紀錄。')
      .setFooter({ text: `共 ${total} 筆，顯示最近 ${warnings.length} 筆` })], allowedMentions: noMentions });
    return;
  }
  if (command.commandName === 'clear') {
    let channel = textChannel(context.channel);
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages];
    assertPermissions(requireBotPermissions(context.bot, channel, required));
    if (!channel.permissionsFor(context.actor).has(required)) throw new UserError('你缺少查看頻道、讀取歷史或管理訊息的權限。');
    const amount = command.options.getInteger('amount', true);
    const messages = await channel.messages.fetch({ limit: amount });
    const selected = recentMessageIds(messages.values());
    if (!selected.length) throw new UserError('選取範圍內沒有可刪除的訊息；僅能清理 14 天內的訊息。');
    if (!await confirm(command, `將刪除 <#${channel.id}> 中已選取的 ${selected.length} 則訊息。此操作無法還原。`)) return;
    context = await getContext(command);
    channel = textChannel(context.channel);
    assertPermissions(requireBotPermissions(context.bot, channel, required));
    if (!channel.permissionsFor(context.actor).has(required)) throw new UserError('你的頻道權限已變更，未執行清理。');
    // Delete the confirmed snapshot; messages arriving during confirmation are excluded.
    const deleted = await channel.bulkDelete(selected, true);
    const suffix = await record(command, store, 'clear', null, '管理員清理訊息', `頻道 ${channel.id}；已送出刪除 ${deleted.size} 則訊息的請求`);
    await command.editReply({ content: `已完成清理請求，本次送出 ${deleted.size} 則訊息。超過時限或已刪除的訊息會略過。${suffix}`, components: [] });
    return;
  }
  if (command.commandName === 'unban') {
    assertPermissions(requireBotPermissions(context.bot, null, [PermissionFlagsBits.BanMembers]));
    const userId = command.options.getString('user_id', true).trim();
    if (!/^\d{17,20}$/.test(userId)) throw new UserError('使用者 ID 必須是 17 至 20 位數字。');
    const reason = reasonFor(command);
    await command.guild.bans.remove(userId, auditReason(command, reason));
    const suffix = await record(command, store, 'unban', userId, reason);
    await command.editReply({ content: `已解除 <@${userId}> 的封鎖。${suffix}`, allowedMentions: noMentions });
    return;
  }
  const action = command.commandName;
  if (!['warn', 'timeout', 'untimeout', 'kick', 'ban'].includes(action)) {
    throw new UserError('找不到此指令，請重新註冊指令。');
  }
  const reason = reasonFor(command);
  let target = await getTarget(command, context, action as ModerationAction);
  if (action === 'kick' || action === 'ban') {
    const days = action === 'ban' ? command.options.getInteger('delete_days') ?? 0 : 0;
    const deletion = days ? `\n將同時刪除對方最近 ${days} 天的訊息。` : '';
    if (!await confirm(command, `確定要${actionLabels[action]} <@${target.id}>？\n原因：${escapeMarkdown(reason)}${deletion}`)) return;
    context = await getContext(command);
    target = await getTarget(command, context, action);
  }
  let detail: string | undefined;
  let result: string;
  switch (action) {
    case 'warn': {
      const warning = store.addWarning({ guildId: command.guildId, userId: target.id, moderatorId: command.user.id, reason });
      result = `已為 <@${target.id}> 記錄警告 #${warning.id}。累計 ${store.countWarnings(command.guildId, target.id)} 筆。`;
      break;
    }
    case 'timeout': {
      const minutes = command.options.getInteger('minutes', true);
      await target.timeout(minutes * 60_000, auditReason(command, reason));
      detail = `${minutes} 分鐘`;
      result = `已將 <@${target.id}> 禁言 ${minutes} 分鐘。`;
      break;
    }
    case 'untimeout':
      await target.timeout(null, auditReason(command, reason));
      result = `已解除 <@${target.id}> 的禁言。`;
      break;
    case 'kick':
      await target.kick(auditReason(command, reason));
      result = `已將 <@${target.id}> 踢出伺服器。`;
      break;
    case 'ban': {
      const days = command.options.getInteger('delete_days') ?? 0;
      await target.ban({ reason: auditReason(command, reason), deleteMessageSeconds: days * 86_400 });
      detail = `刪除最近 ${days} 天訊息`;
      result = `已封鎖 <@${target.id}>。`;
      break;
    }
    default: throw new UserError('不支援此操作。');
  }
  const suffix = await record(command, store, action, target.id, reason, detail);
  await command.editReply({ content: result + suffix, components: [], allowedMentions: noMentions });
}

export async function handleInteraction(interaction: Interaction, store: Store): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: '請在機器人所在的伺服器內使用指令。', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await run(interaction, store);
  } catch (error) {
    if (!(error instanceof UserError)) logFailure('管理指令執行失敗', error);
    try {
      const response = { content: errorMessage(error), embeds: [], components: [], allowedMentions: noMentions };
      if (interaction.deferred || interaction.replied) await interaction.editReply(response);
      else await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      logFailure('指令錯誤回覆失敗', replyError);
    }
  }
}

export async function welcomeMember(member: GuildMember, store: Store): Promise<void> {
  try {
    const settings = store.getSettings(member.guild.id);
    if (!settings.welcomeChannelId) return;
    const channel = textChannel(await member.guild.channels.fetch(settings.welcomeChannelId));
    const content = formatWelcome(settings.welcomeMessage, {
      userId: member.id, serverName: member.guild.name, memberCount: member.guild.memberCount,
    });
    await channel.send({ content, allowedMentions: { parse: [], users: [member.id] } });
  } catch (error) {
    logFailure('歡迎訊息發送失敗', error);
  }
}
