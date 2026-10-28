import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType, EmbedBuilder,
  PermissionFlagsBits, escapeMarkdown,
  type ChatInputCommandInteraction, type GuildMember, type Role,
} from 'discord.js';
import { record } from './audit.js';
import { UserError } from './errors.js';
import { requireBotPermissions } from './permissions.js';
import { truncate } from './presentation.js';
import { Store, type ModerationCase } from './store.js';

type Command = ChatInputCommandInteraction<'cached'>;
const noMentions = { parse: [] as never[] };
const sensitivePermissions = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild
  | PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.KickMembers
  | PermissionFlagsBits.BanMembers | PermissionFlagsBits.ModerateMembers | PermissionFlagsBits.ManageWebhooks
  | PermissionFlagsBits.ManageMessages | PermissionFlagsBits.ManageThreads | PermissionFlagsBits.ManageEvents
  | PermissionFlagsBits.ManageNicknames | PermissionFlagsBits.MentionEveryone | PermissionFlagsBits.ViewAuditLog;

function nativeAdmin(member: GuildMember, ownerId: string): boolean {
  return member.id === ownerId || member.permissions.has(PermissionFlagsBits.Administrator);
}

async function authority(command: Command, extra?: bigint): Promise<{ actor: GuildMember; bot: GuildMember }> {
  await command.guild.roles.fetch();
  const [actor, bot] = await Promise.all([
    command.guild.members.fetch({ user: command.user.id, force: true }),
    command.guild.members.fetchMe({ force: true }),
  ]);
  if (!nativeAdmin(actor, command.guild.ownerId)
    && (!actor.permissions.has(PermissionFlagsBits.ManageGuild) || (extra !== undefined && !actor.permissions.has(extra)))) {
    throw new UserError('此管理功能需要原生管理伺服器權限及對應操作權限，Bot 管理授權不適用。');
  }
  return { actor, bot };
}

function reason(command: Command): string {
  const value = command.options.getString('reason', true).trim();
  if (!value || value.length > 512) throw new UserError('請填寫 1 至 512 字的操作原因。');
  return value;
}

function caseId(command: Command): number {
  const id = command.options.getInteger('id', true);
  if (!Number.isSafeInteger(id) || id < 1) throw new UserError('請填寫有效的正整數編號。');
  return id;
}

function caseEmbed(item: ModerationCase): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`本服案件 #${item.caseNumber}`)
    .addFields(
      { name: '操作', value: truncate(escapeMarkdown(item.action), 100) },
      { name: '對象', value: item.userId ? `<@${item.userId}>（${item.userId}）` : '頻道或伺服器設定' },
      { name: '執行者', value: `<@${item.moderatorId}>（${item.moderatorId}）` },
      { name: '原因', value: truncate(escapeMarkdown(item.reason), 1024) },
    ).setTimestamp(new Date(item.createdAt));
  if (item.details) embed.addFields({ name: '詳細內容', value: truncate(escapeMarkdown(item.details), 1024) });
  return embed;
}

async function confirmWarningRemoval(command: Command, warningId: number, userId: string): Promise<boolean> {
  const yes = `admin:warning-remove:${command.id}`;
  const no = `admin:cancel:${command.id}`;
  const message = await command.editReply({
    content: `確定要移除 <@${userId}> 的警告 #${warningId}？原始案件與本次操作紀錄都會保留。\n請在 30 秒內確認。`,
    embeds: [], allowedMentions: noMentions,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(yes).setLabel('確認移除警告').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(no).setLabel('取消').setStyle(ButtonStyle.Secondary),
    )],
  });
  let button;
  try {
    button = await message.awaitMessageComponent({ componentType: ComponentType.Button, time: 30_000,
      filter: (interaction) => interaction.user.id === command.user.id && [yes, no].includes(interaction.customId) });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'InteractionCollectorError') {
      await command.editReply({ content: '確認已逾時，未移除警告。', components: [] });
      return false;
    }
    throw error;
  }
  const accepted = button.customId === yes;
  await button.update({ content: accepted ? '正在移除警告…' : '已取消操作。', components: [] });
  return accepted;
}

function above(first: Role, second: Role): boolean {
  return first.comparePositionTo(second) > 0;
}

function assertRoleTarget(command: Command, actor: GuildMember, bot: GuildMember, target: GuildMember, role: Role): void {
  if (target.id === actor.id || target.id === bot.id || target.id === command.guild.ownerId
    || target.user.bot || target.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new UserError('無法修改自己、機器人、伺服器擁有者或管理員的身分組。');
  }
  if (role.id === command.guildId || role.managed) throw new UserError('無法操作 @everyone 或由整合服務管理的身分組。');
  if (actor.id !== command.guild.ownerId && (!above(actor.roles.highest, target.roles.highest) || !above(actor.roles.highest, role))) {
    throw new UserError('你的最高角色必須高於目標成員及要操作的身分組。');
  }
  if (!above(bot.roles.highest, target.roles.highest) || !above(bot.roles.highest, role) || !target.manageable || !role.editable) {
    throw new UserError('機器人的最高角色必須高於目標成員及要操作的身分組。');
  }
  if (!nativeAdmin(actor, command.guild.ownerId) && (role.permissions.bitfield & sensitivePermissions) !== 0n) {
    throw new UserError('只有原生管理員可以透過 Bot 增減帶有管理或大量通知權限的身分組。');
  }
  const permissionError = requireBotPermissions(bot, null, [PermissionFlagsBits.ManageRoles]);
  if (permissionError) throw new UserError(permissionError);
}

async function editRole(command: Command, store: Store, add: boolean): Promise<void> {
  await authority(command, PermissionFlagsBits.ManageRoles);
  const selectedUser = command.options.getUser('user', true);
  const selectedRole = command.options.getRole('role', true);
  const explanation = reason(command);
  const [target, fetchedRole] = await Promise.all([
    command.guild.members.fetch({ user: selectedUser.id, force: true }),
    command.guild.roles.fetch(selectedRole.id, { force: true }),
  ]);
  if (!fetchedRole) throw new UserError('找不到此伺服器的身分組。');
  const current = await authority(command, PermissionFlagsBits.ManageRoles);
  const role = command.guild.roles.cache.get(fetchedRole.id);
  if (!role || role.guild.id !== command.guildId || target.guild.id !== command.guildId) throw new UserError('找不到此伺服器的成員或身分組。');
  assertRoleTarget(command, current.actor, current.bot, target, role);
  const alreadyPresent = target.roles.cache.has(role.id);
  if (alreadyPresent === add) {
    await command.editReply({ content: add ? '此成員已擁有該身分組。' : '此成員目前沒有該身分組。', allowedMentions: noMentions });
    return;
  }
  const auditReason = truncate(`${command.user.id}：${explanation}`, 512);
  if (add) await target.roles.add(role.id, auditReason);
  else await target.roles.remove(role.id, auditReason);
  const suffix = await record(command, store, add ? 'role-add' : 'role-remove', target.id,
    explanation, `身分組 ${role.id}`);
  await command.editReply({ content: `已${add ? '新增' : '移除'} <@${target.id}> 的 <@&${role.id}> 身分組。${suffix}`, allowedMentions: noMentions });
}

async function editChannel(command: Command, store: Store): Promise<void> {
  await authority(command, PermissionFlagsBits.ManageChannels);
  const selected = command.options.getChannel('channel', true);
  const rawName = command.options.getString('name');
  const slowmode = command.options.getInteger('slowmode');
  const nsfw = command.options.getBoolean('nsfw');
  const explanation = reason(command);
  const name = rawName?.trim();
  if (rawName !== null && (!name || name.length > 100 || /[\p{Cc}\p{Cs}]/u.test(name))) {
    throw new UserError('頻道名稱需為 1 至 100 字，不能包含控制字元。');
  }
  if (slowmode !== null && (!Number.isInteger(slowmode) || slowmode < 0 || slowmode > 21_600)) {
    throw new UserError('慢速模式需為 0 至 21600 秒。');
  }
  if (rawName === null && slowmode === null && nsfw === null) throw new UserError('請至少填寫一項要修改的頻道設定。');
  const channel = await command.guild.channels.fetch(selected.id, { force: true });
  if (!channel || channel.guildId !== command.guildId
    || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    throw new UserError('請選擇本伺服器的文字頻道或公告頻道。');
  }
  if (channel.type === ChannelType.GuildAnnouncement && slowmode !== null) throw new UserError('公告頻道不支援慢速模式，請選擇一般文字頻道。');
  const current = await authority(command, PermissionFlagsBits.ManageChannels);
  if (!channel.permissionsFor(current.actor)?.has(PermissionFlagsBits.ViewChannel)) throw new UserError('你目前無法查看此頻道。');
  if (!nativeAdmin(current.actor, command.guild.ownerId)
    && !channel.permissionsFor(current.actor)?.has(PermissionFlagsBits.ManageChannels)) {
    throw new UserError('你目前沒有管理此頻道的權限。');
  }
  const permissionError = requireBotPermissions(current.bot, channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]);
  if (permissionError) throw new UserError(permissionError);
  const changes: { name?: string; rateLimitPerUser?: number; nsfw?: boolean; reason: string } = {
    reason: truncate(`${command.user.id}：${explanation}`, 512),
  };
  if (name !== undefined) changes.name = name;
  if (slowmode !== null) changes.rateLimitPerUser = slowmode;
  if (nsfw !== null) changes.nsfw = nsfw;
  await channel.edit(changes);
  const details = [`頻道 ${channel.id}`, ...(name === undefined ? [] : [`名稱 ${name}`]),
    ...(slowmode === null ? [] : [`慢速模式 ${slowmode} 秒`]), ...(nsfw === null ? [] : [`NSFW ${nsfw}`])].join('；');
  const suffix = await record(command, store, 'channel-edit', null, explanation, details);
  await command.editReply({ content: `已更新 <#${channel.id}> 的頻道設定。${suffix}`, allowedMentions: noMentions });
}

/** Native server management only. Called after an ephemeral defer. */
export async function handleAdminCommand(command: Command, store: Store): Promise<void> {
  const subcommand = command.options.getSubcommand();
  if (subcommand === 'role-add' || subcommand === 'role-remove') return editRole(command, store, subcommand === 'role-add');
  if (subcommand === 'channel-edit') return editChannel(command, store);
  await authority(command);
  if (subcommand === 'cases') {
    const selected = command.options.getUser('user');
    const cases = selected ? store.listUserCases(selected.id, command.guildId, 10) : store.listCases(command.guildId, 10);
    await command.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('伺服器案件紀錄')
      .setDescription(cases.length ? truncate(cases.map((item) =>
        `**#${item.caseNumber}** · ${truncate(escapeMarkdown(item.action), 60)} · ${item.userId ? `<@${item.userId}>` : '頻道／設定'} · 執行者 <@${item.moderatorId}>\n${truncate(escapeMarkdown(item.reason), 200)}`,
      ).join('\n\n'), 3900) : '沒有符合條件的案件。')
      .setFooter({ text: '本服獨立編號，顯示最近 10 筆；使用 /admin case id 查看完整案件。' })], allowedMentions: noMentions });
    return;
  }
  if (subcommand === 'case') {
    const item = store.getGuildCase(command.guildId, caseId(command));
    if (!item) throw new UserError('找不到此伺服器的案件。');
    await command.editReply({ embeds: [caseEmbed(item)], allowedMentions: noMentions });
    return;
  }
  if (subcommand === 'warning-remove') {
    const id = caseId(command);
    const explanation = reason(command);
    const warning = store.getWarning(command.guildId, id);
    if (!warning) throw new UserError('找不到此伺服器的警告。');
    if (!await confirmWarningRemoval(command, warning.id, warning.userId)) return;
    await authority(command);
    const removed = store.removeWarning(command.guildId, id);
    if (!removed) throw new UserError('此警告已由其他管理員移除，未重複執行。');
    const suffix = await record(command, store, 'warning-remove', removed.userId, explanation,
      `移除警告 #${removed.id}；原執行者 ${removed.moderatorId}；原原因 ${removed.reason}`);
    await command.editReply({ content: `已移除警告 #${removed.id}，原始案件紀錄保留。${suffix}`, components: [], allowedMentions: noMentions });
    return;
  }
  throw new UserError('找不到此管理員操作，請更新指令。');
}
