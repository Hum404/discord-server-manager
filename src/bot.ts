import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType,
  EmbedBuilder, MessageFlags, PermissionFlagsBits, escapeMarkdown,
  type ChatInputCommandInteraction, type GuildBasedChannel,
  type GuildMember, type Interaction, type NewsChannel, type TextChannel,
} from 'discord.js';
import { checkModerationTarget, requireBotPermissions, type ModerationAction } from './permissions.js';
import { formatWelcome, recentMessageIds, truncate } from './presentation.js';
import { Store } from './store.js';
import { record } from './audit.js';
import { errorMessage, logFailure, UserError } from './errors.js';
export { logFailure } from './errors.js';
import { handleAccessCommand, resolveModerationAuthority } from './access.js';
import { handleAppealCommand, handleAppealInteraction, notifyPunishment } from './appeals.js';
import { handleSubareaCommand } from './subareas.js';
import { scopeForCommand } from './domain.js';
import { assertPrivateAppealChannel } from './appeal-privacy.js';
import { handleAdminCommand } from './admin.js';
import { handleMessageAppCommand } from './message-apps.js';
import { handleRecordsCommand } from './records.js';

type Command = ChatInputCommandInteraction<'cached'>;
type Context = {
  actor: GuildMember; authority: GuildMember; delegated: boolean;
  bot: GuildMember; channel: GuildBasedChannel | null;
};
const noMentions = { parse: [] as never[] };
const actionLabels: Record<string, string> = {
  warn: '警告', timeout: '禁言', untimeout: '解除禁言', kick: '踢出',
  ban: '封鎖', unban: '解除封鎖', clear: '清理訊息', config: '更新設定',
};

function assertPermissions(error: string | null): void {
  if (error) throw new UserError(error);
}

async function getContext(command: Command, store: Store): Promise<Context> {
  // Refresh roles and members, including after a confirmation, to honor permission changes.
  await command.guild.roles.fetch();
  const [actor, bot, channel] = await Promise.all([
    command.guild.members.fetch({ user: command.user.id, force: true }),
    command.guild.members.fetchMe({ force: true }),
    command.guild.channels.fetch(command.channelId, { force: true }),
  ]);
  const authority = await resolveModerationAuthority(command, actor, channel, store);
  return { actor, bot, channel, ...authority };
}

async function getTarget(command: Command, context: Context, action: ModerationAction, store: Store): Promise<GuildMember> {
  const user = command.options.getUser('user', true);
  const target = await command.guild.members.fetch({ user: user.id, force: true });
  if (context.delegated) {
    const scope = scopeForCommand(command.commandName);
    const active = scope ? store.getGrant(command.guildId, context.actor.id, scope) : null;
    if (!active || active.grantedBy !== context.authority.id
      || (context.authority.id !== command.guild.ownerId
        && !context.authority.permissions.has(PermissionFlagsBits.Administrator))) {
      throw new UserError('管理授權已被撤回或變更，未執行操作。');
    }
  }
  if (context.delegated && (target.permissions.has(PermissionFlagsBits.Administrator)
    || target.permissions.has(PermissionFlagsBits.ManageGuild))) {
    throw new UserError('管理授權不能用來處罰伺服器管理員。');
  }
  assertPermissions(checkModerationTarget({
    actorId: context.actor.id,
    actorHighestPosition: context.authority.roles.highest.position,
    actorIsOwner: command.guild.ownerId === context.authority.id,
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

async function configure(command: Command, context: Context, store: Store): Promise<void> {
  const subcommand = command.options.getSubcommand();
  const settings = store.getSettings(command.guildId);
  if (subcommand === 'view') {
    await command.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('伺服器設定')
      .addFields(
        { name: '管理紀錄頻道', value: settings.logChannelId ? `<#${settings.logChannelId}>` : '未啟用' },
        { name: '歡迎頻道', value: settings.welcomeChannelId ? `<#${settings.welcomeChannelId}>` : '未啟用' },
        { name: '申訴工單頻道', value: settings.appealChannelId ? `<#${settings.appealChannelId}>` : '未設定；可用 /appeal queue 查看' },
        { name: '子區分類', value: settings.subareaCategoryId ? `<#${settings.subareaCategoryId}>` : '未啟用子區建立' },
        { name: '子區論壇', value: settings.subareaForumId ? `<#${settings.subareaForumId}>` : '未設定' },
        { name: '歡迎內容', value: truncate(escapeMarkdown(settings.welcomeMessage), 1024) },
      )], allowedMentions: noMentions });
    return;
  }
  let detail: string;
  if (subcommand === 'subareas') {
    const selected = command.options.getChannel('category');
    const selectedForum = command.options.getChannel('forum');
    if (selected) {
      const category = await command.guild.channels.fetch(selected.id, { force: true });
      if (!category || category.type !== ChannelType.GuildCategory) throw new UserError('請選擇本伺服器的分類。');
      assertPermissions(requireBotPermissions(context.bot, category, [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles,
      ]));
    }
    if (selectedForum) {
      const forum = await command.guild.channels.fetch(selectedForum.id, { force: true });
      if (!forum || forum.type !== ChannelType.GuildForum) throw new UserError('請選擇本伺服器的論壇頻道。');
      assertPermissions(requireBotPermissions(context.bot, forum, [PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ManageThreads]));
    }
    const refreshed = await getContext(command, store);
    if (refreshed.actor.id !== command.guild.ownerId && !refreshed.actor.permissions.has(PermissionFlagsBits.ManageGuild)) {
      throw new UserError('你的設定權限已變更，未修改子區設定。');
    }
    store.updateSettings(command.guildId, { subareaCategoryId: selected?.id ?? null, subareaForumId: selectedForum?.id ?? null });
    detail = selected || selectedForum
      ? `已更新子區建立範圍：${selected ? `分類 <#${selected.id}>` : ''}${selected && selectedForum ? '、' : ''}${selectedForum ? `論壇 <#${selectedForum.id}>` : ''}。`
      : '已停用用戶建立新子區；既有子區仍可管理。';
  } else if (subcommand === 'appeals') {
    const selected = command.options.getChannel('channel');
    if (selected) {
      const channel = await command.guild.channels.fetch(selected.id, { force: true });
      if (!channel || channel.type !== ChannelType.GuildText) throw new UserError('申訴工單必須使用本伺服器的文字頻道。');
      await assertPrivateAppealChannel(channel, context.bot.id);
      assertPermissions(requireBotPermissions(context.bot, channel, [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
      ]));
    }
    store.updateSettings(command.guildId, { appealChannelId: selected?.id ?? null });
    detail = selected ? `已設定申訴工單頻道為 <#${selected.id}>。` : '已停用申訴頻道通知；工單仍會保存，可用 /appeal queue 查看。';
  } else if (subcommand === 'welcome-message') {
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
      : subcommand === 'logs' ? '已停用本服日誌頻道通知；本機案件仍會保存供查詢與申訴。' : '已停用歡迎訊息。';
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
        { name: '一般', value: '`/help` 指令說明\n`/ping` 連線狀態\n長按／右鍵訊息 → APP → 標註／取消標註、刪除訊息' },
        { name: '成員管理', value: '`/warn` 新增警告\n`/warnings` 最近 10 筆警告\n`/timeout` 禁言（最長 28 天）\n`/untimeout` 解除禁言\n`/kick` 踢出\n`/ban` 封鎖\n`/unban` 以 ID 解除封鎖' },
        { name: '頻道與設定', value: '`/clear` 清理最近訊息（最多 100 則）\n`/config view` 查看設定\n`/config logs` 管理紀錄頻道\n`/config welcome` 歡迎頻道\n`/config welcome-message` 歡迎內容' },
        { name: '授權與申訴', value: '`/access grant` 授權管理功能\n`/access revoke` 撤回授權\n`/appeal submit` 提交申訴\n`/appeal status` 查詢工單\n`/appeal queue` 管理員工單清單\n`/appeal review` 審核工單' },
        { name: '子區管理', value: '`/config subareas` 設定分類／論壇\n`/subarea create` 建立文字頻道／討論串／論壇帖子\n`/subarea pin`、`unpin` 建立者置頂訊息\n`/subarea mute`、`kick` 管理區內成員\n`/subarea delegate`、`undelegate` 授權協管\n`/subarea info` 查看狀態與管理者' },
        { name: '子區工具', value: '`/subarea delete-message` 刪除指定訊息\n`/subarea slowmode` 慢速模式\n`/subarea rename` 修改名稱\n`/subarea lock`、`unlock` 鎖定／解鎖\n`/subarea delete` 建立者刪區（兩次確認）\n`/subarea tag`、`role-tag`、`announce` 建立者提及通知' },
        { name: '紀錄與管理員工具', value: '`/records` 查看自己的成員操作紀錄\n`/records direction:received` 查看收到的子區操作\n`/admin cases`、`case` 伺服器處罰案件\n`/admin warning-remove` 撤銷警告紀錄\n`/admin role-add`、`role-remove` 管理身分組\n`/admin channel-edit` 編輯文字頻道' },
        { name: '使用提醒', value: '踢出、封鎖、清理訊息須在 30 秒內確認。歡迎內容支援 `{user}`、`{server}`、`{count}`。設定頻道時留空可停用。' },
      )] });
    return;
  }
  if (command.commandName === 'ping') {
    await command.editReply(`機器人運作中。Gateway 延遲：${command.client.ws.ping < 0 ? '計算中' : `${command.client.ws.ping} ms`}。`);
    return;
  }
  let context = await getContext(command, store);
  if (command.commandName === 'config') return configure(command, context, store);
  if (command.commandName === 'access') return handleAccessCommand(command, store);
  if (command.commandName === 'subarea') return handleSubareaCommand(command, store);
  if (command.commandName === 'admin') return handleAdminCommand(command, store);
  if (command.commandName === 'records') return handleRecordsCommand(command, store);
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
    const actorRequired = context.delegated ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] : required;
    if (!channel.permissionsFor(context.actor).has(actorRequired)) throw new UserError('你缺少查看頻道、讀取歷史或管理訊息的權限。');
    const amount = command.options.getInteger('amount', true);
    const messages = await channel.messages.fetch({ limit: amount });
    const selected = recentMessageIds(messages.values());
    if (!selected.length) throw new UserError('選取範圍內沒有可刪除的訊息；僅能清理 14 天內的訊息。');
    if (!await confirm(command, `將刪除 <#${channel.id}> 中已選取的 ${selected.length} 則訊息。此操作無法還原。`)) return;
    context = await getContext(command, store);
    channel = textChannel(context.channel);
    assertPermissions(requireBotPermissions(context.bot, channel, required));
    if (!channel.permissionsFor(context.actor).has(context.delegated
      ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] : required)) {
      throw new UserError('你的頻道權限已變更，未執行清理。');
    }
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
  let target = await getTarget(command, context, action as ModerationAction, store);
  if (action === 'kick' || action === 'ban') {
    const days = action === 'ban' ? command.options.getInteger('delete_days') ?? 0 : 0;
    const deletion = days ? `\n將同時刪除對方最近 ${days} 天的訊息。` : '';
    if (!await confirm(command, `確定要${actionLabels[action]} <@${target.id}>？\n原因：${escapeMarkdown(reason)}${deletion}`)) return;
    context = await getContext(command, store);
    target = await getTarget(command, context, action, store);
  }
  let noticeFailed = false;
  if (action !== 'untimeout') {
    noticeFailed = !await notifyPunishment(target, action, reason);
    // Delivering the DM awaited Discord: honor revocations and role changes made meanwhile.
    context = await getContext(command, store);
    target = await getTarget(command, context, action as ModerationAction, store);
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
  await command.editReply({ content: result + suffix
    + (noticeFailed ? '\n⚠️ 無法私訊申訴入口；請另行通知該用戶案件編號與申訴方式。' : ''),
  components: [], allowedMentions: noMentions });
}

export async function handleInteraction(interaction: Interaction, store: Store): Promise<void> {
  try {
    if (!interaction.isChatInputCommand()) {
      if (interaction.isMessageContextMenuCommand()) {
        await handleMessageAppCommand(interaction, store);
        return;
      }
      await handleAppealInteraction(interaction, store);
      return;
    }
    if (interaction.commandName === 'appeal') {
      await handleAppealCommand(interaction, store);
      return;
    }
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: '請在機器人所在的伺服器內使用指令。', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await run(interaction, store);
  } catch (error) {
    if (!(error instanceof UserError)) logFailure('管理指令執行失敗', error);
    if (!interaction.isRepliable()) return;
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
