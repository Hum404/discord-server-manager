import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
  escapeMarkdown, type ButtonInteraction, type ChatInputCommandInteraction,
  type Client, type Guild, type GuildMember, type Interaction, type ModalSubmitInteraction,
} from 'discord.js';
import { APPEALABLE_ACTIONS } from './domain.js';
import { UserError, logFailure } from './errors.js';
import { truncate } from './presentation.js';
import { Store, type Appeal, type ModerationCase } from './store.js';
import { assertPrivateAppealChannel } from './appeal-privacy.js';

type ReplyInteraction = ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction;
type ReviewResult = 'accepted' | 'rejected';
const noMentions = { parse: [] as never[] };
const unavailable = '找不到可供你申訴的案件或工單。';
const statusLabels: Record<Appeal['status'], string> = { open: '待審核', accepted: '申訴通過', rejected: '申訴駁回' };
const actionLabels: Record<string, string> = {
  warn: '警告', timeout: '禁言', kick: '踢出伺服器', ban: '封鎖',
  'subarea-mute': '子區禁言', 'subarea-kick': '子區移除',
};

function flags(interaction: ReplyInteraction): { flags?: MessageFlags.Ephemeral } {
  return interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {};
}

async function respond(interaction: ReplyInteraction, content: string): Promise<void> {
  const payload = { content, allowedMentions: noMentions };
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else await interaction.reply({ ...payload, ...flags(interaction) });
}

async function acknowledge(interaction: ReplyInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply(flags(interaction));
}

async function reportError(interaction: ReplyInteraction, error: unknown): Promise<void> {
  if (!(error instanceof UserError)) logFailure('申訴處理失敗', error);
  try {
    await respond(interaction, error instanceof UserError ? error.message : '申訴操作未完成，請稍後再試。');
  } catch (replyError) {
    logFailure('申訴錯誤回覆失敗', replyError);
  }
}

function validCase(store: Store, caseId: number, userId: string, guildId?: string): ModerationCase {
  if (!Number.isSafeInteger(caseId) || caseId < 1) throw new UserError(unavailable);
  const original = store.getCase(caseId);
  if (!original || original.userId !== userId || !APPEALABLE_ACTIONS.has(original.action)
    || (guildId !== undefined && original.guildId !== guildId)) throw new UserError(unavailable);
  return original;
}

/** Public numbers are meaningful only inside a guild; internal IDs never select a new form. */
function localCase(store: Store, caseNumber: number, userId: string, guildId?: string): ModerationCase {
  if (!Number.isSafeInteger(caseNumber) || caseNumber < 1) throw new UserError(unavailable);
  const candidates = guildId === undefined ? store.findUserCasesByNumber(userId, caseNumber)
    : [store.getGuildCase(guildId, caseNumber)];
  const owned = candidates.filter((entry): entry is ModerationCase =>
    entry !== null && entry.userId === userId && APPEALABLE_ACTIONS.has(entry.action));
  if (owned.length > 1) {
    const guilds = truncate(owned.map((entry) => entry.guildId).join('、'), 500);
    throw new UserError(`你在多個伺服器都有案件 #${caseNumber}（伺服器：${guilds}）。請在案件所屬伺服器內執行，或使用該伺服器處罰私訊中的「提交申訴」按鈕。`);
  }
  if (!owned.length) throw new UserError(unavailable);
  return owned[0]!;
}

function selectedCase(store: Store, userId: string, guildId: string | undefined, requestedId?: number | null): ModerationCase {
  if (requestedId !== undefined && requestedId !== null) return localCase(store, requestedId, userId, guildId);
  const original = store.listUserCases(userId, guildId, 100).find((entry) => APPEALABLE_ACTIONS.has(entry.action));
  if (!original) throw new UserError('目前尚無已完成的可申訴案件；若處罰正在執行，請稍後再按一次。');
  return original;
}

function appealModal(original: ModerationCase, userId: string): ModalBuilder {
  return new ModalBuilder().setCustomId(`appeal:submit-local:${original.guildId}:${userId}`)
    .setTitle('提交處罰申訴')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
        .setCustomId('case_id').setLabel('此伺服器的案件編號').setStyle(TextInputStyle.Short)
        .setValue(String(original.caseNumber)).setMinLength(1).setMaxLength(16).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
        .setCustomId('reason').setLabel('申訴原因與補充說明').setStyle(TextInputStyle.Paragraph)
        .setMinLength(1).setMaxLength(1000).setRequired(true)),
    );
}

function reviewModal(appeal: Appeal, result: ReviewResult, reviewerId: string): ModalBuilder {
  return new ModalBuilder().setCustomId(`appeal:decision:${appeal.id}:${result}:${reviewerId}`)
    .setTitle(result === 'accepted' ? '通過申訴' : '駁回申訴')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
      .setCustomId('response').setLabel('審核結果說明').setStyle(TextInputStyle.Paragraph)
      .setMinLength(1).setMaxLength(1000).setRequired(true)));
}

function ticketEmbed(appeal: Appeal, original: ModerationCase): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(appeal.status === 'open' ? 0xf0b232 : appeal.status === 'accepted' ? 0x23a55a : 0xda373c)
    .setTitle(`申訴工單 #${appeal.id} · ${statusLabels[appeal.status]}`)
    .addFields(
      { name: '申訴者', value: `<@${appeal.userId}>（${appeal.userId}）` },
      { name: '所屬伺服器', value: appeal.guildId },
      { name: '原案件', value: `#${original.caseNumber} · ${actionLabels[original.action] ?? original.action}` },
      { name: '原處罰原因', value: truncate(escapeMarkdown(original.reason), 1024) },
      { name: '申訴說明', value: truncate(escapeMarkdown(appeal.reason), 1024) },
    ).setTimestamp(new Date(appeal.createdAt));
  if (appeal.response) embed.addFields({ name: '審核說明', value: truncate(escapeMarkdown(appeal.response), 1024) });
  if (appeal.reviewerId) embed.addFields({ name: '審核者', value: `<@${appeal.reviewerId}>` });
  if (appeal.status === 'accepted') embed.setFooter({ text: '此結果不會自動撤銷處罰，請管理員另行解除禁言或封鎖。' });
  return embed;
}

function reviewButtons(appeal: Appeal): ActionRowBuilder<ButtonBuilder>[] {
  if (appeal.status !== 'open') return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`appeal:review:${appeal.id}:accepted`).setLabel('通過申訴').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`appeal:review:${appeal.id}:rejected`).setLabel('駁回申訴').setStyle(ButtonStyle.Danger),
  )];
}

async function staffGuild(interaction: ReplyInteraction, guildId: string): Promise<Guild> {
  if (!interaction.inGuild() || interaction.guildId !== guildId) throw new UserError('請在工單所屬伺服器審核申訴。');
  const guild = interaction.guild ?? await interaction.client.guilds.fetch(guildId);
  await guild.roles.fetch();
  const reviewer = await guild.members.fetch({ user: interaction.user.id, force: true });
  if (guild.ownerId !== reviewer.id && !reviewer.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('只有具備原生「管理伺服器」權限的管理員可以查看或審核申訴工單。');
  }
  return guild;
}

async function postTicket(client: Client, store: Store, appeal: Appeal, original: ModerationCase): Promise<boolean> {
  try {
    const channelId = store.getSettings(appeal.guildId).appealChannelId;
    if (!channelId) return false;
    const guild = await client.guilds.fetch(appeal.guildId);
    await guild.roles.fetch();
    const [channel, bot] = await Promise.all([
      guild.channels.fetch(channelId, { force: true }), guild.members.fetchMe({ force: true }),
    ]);
    if (!channel || channel.type !== ChannelType.GuildText
      || !channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      throw new UserError('申訴通知頻道必須為非公開文字頻道，且機器人需要檢視、發送與嵌入連結權限。');
    }
    await assertPrivateAppealChannel(channel, bot.id);
    const message = await channel.send({ embeds: [ticketEmbed(appeal, original)], components: reviewButtons(appeal), allowedMentions: noMentions });
    store.setAppealMessage(appeal.id, appeal.guildId, channel.id, message.id);
    return true;
  } catch (error) {
    logFailure('申訴工單已儲存，但管理頻道通知失敗', error);
    return false;
  }
}

function auditAppeal(store: Store, appeal: Appeal, actorId: string, action: string, reason: string): void {
  try {
    const original = validCase(store, appeal.caseId, appeal.userId, appeal.guildId);
    store.addCase({ guildId: appeal.guildId, action, userId: appeal.userId, moderatorId: actorId,
      reason, details: `申訴工單 #${appeal.id}；原案件 #${original.caseNumber}` });
  } catch (error) {
    logFailure('申訴工單已儲存，但操作紀錄寫入失敗', error);
  }
}

async function submitAppeal(
  interaction: ModalSubmitInteraction, store: Store, guildId: string, userId: string, legacyInternalId = false,
): Promise<void> {
  if (interaction.user.id !== userId || (interaction.inGuild() && interaction.guildId !== guildId)) throw new UserError(unavailable);
  const caseText = interaction.fields.getTextInputValue('case_id').trim();
  if (!/^[0-9]+$/.test(caseText)) throw new UserError('請輸入有效的案件編號。');
  const original = legacyInternalId ? validCase(store, Number(caseText), userId, guildId)
    : localCase(store, Number(caseText), userId, guildId);
  const reason = interaction.fields.getTextInputValue('reason').trim();
  if (!reason || reason.length > 1000) throw new UserError('申訴說明須為 1 至 1000 個字元。');
  await acknowledge(interaction);
  const existing = store.getAppealForCase(guildId, original.id, userId);
  if (existing) {
    await respond(interaction, `此案件已有申訴工單 #${existing.id}（${statusLabels[existing.status]}），不會重複建立。`);
    return;
  }
  const appeal = store.createAppeal({ guildId, caseId: original.id, userId, reason });
  auditAppeal(store, appeal, userId, 'appeal-submit', truncate(reason, 1000));
  const posted = await postTicket(interaction.client, store, appeal, original);
  await respond(interaction, `申訴工單 #${appeal.id} 已儲存，等待管理員審核。`
    + (posted ? '' : '\n管理頻道通知未送達；管理員仍可使用 /appeal queue 查看工單。'));
}

async function updateTicket(client: Client, appeal: Appeal, original: ModerationCase): Promise<void> {
  if (!appeal.channelId || !appeal.messageId) return;
  try {
    const guild = await client.guilds.fetch(appeal.guildId);
    const channel = await guild.channels.fetch(appeal.channelId, { force: true });
    if (!channel || channel.type !== ChannelType.GuildText) return;
    await guild.roles.fetch();
    await assertPrivateAppealChannel(channel, client.user!.id);
    const message = await channel.messages.fetch(appeal.messageId);
    await message.edit({ embeds: [ticketEmbed(appeal, original)], components: [], allowedMentions: noMentions });
  } catch (error) { logFailure('申訴已審核，但工單訊息更新失敗', error); }
}

async function review(
  interaction: ReplyInteraction, store: Store, appeal: Appeal, result: ReviewResult, response: string,
): Promise<void> {
  await staffGuild(interaction, appeal.guildId);
  const explanation = response.trim();
  if (!explanation || explanation.length > 1000) throw new UserError('審核說明須為 1 至 1000 個字元。');
  const reviewed = store.reviewAppeal(appeal.id, appeal.guildId, interaction.user.id, result, explanation);
  if (!reviewed) throw new UserError('此工單已由其他管理員完成審核，未重複變更。');
  auditAppeal(store, reviewed, interaction.user.id, 'appeal-review', explanation);
  const original = store.getCase(reviewed.caseId)!;
  await updateTicket(interaction.client, reviewed, original);
  let notified = true;
  try {
    const applicant = await interaction.client.users.fetch(reviewed.userId);
    await applicant.send({ content: `申訴工單 #${reviewed.id}：${statusLabels[result]}。\n審核說明：${explanation}`
      + (result === 'accepted' ? '\n管理員仍需另行解除原處罰；此結果不會自動解除禁言或封鎖。' : ''), allowedMentions: noMentions });
  } catch (error) { notified = false; logFailure('申訴已審核，但私訊通知失敗', error); }
  await respond(interaction, `工單 #${reviewed.id} 已記錄為「${statusLabels[result]}」。`
    + (result === 'accepted' ? '\n請依原案件另行解除處罰；本次未自動撤銷處罰。' : '')
    + (notified ? '' : '\n無法私訊通知申訴者，審核結果已保存。'));
}

/** Deliver the entry before kicks/bans, while a mutual guild still permits DMs. */
export async function notifyPunishment(target: GuildMember, action: string, reason: string): Promise<boolean> {
  if (!APPEALABLE_ACTIONS.has(action)) return true;
  try {
    await target.send({
      embeds: [new EmbedBuilder().setColor(0xf0b232).setTitle('管理操作通知與申訴入口')
        .setDescription(`伺服器：${truncate(escapeMarkdown(target.guild.name), 200)}\n管理操作：${actionLabels[action] ?? action}`)
        .addFields({ name: '原因', value: truncate(escapeMarkdown(reason), 1024) })
        .setFooter({ text: '操作完成後可申訴已記錄的案件。若操作尚未完成，請稍後再按。' })],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
        .setCustomId(`appeal:open:${target.guild.id}:${target.id}`).setLabel('提交申訴').setStyle(ButtonStyle.Primary))],
      allowedMentions: noMentions,
    });
    return true;
  } catch (error) { logFailure('處罰通知與申訴入口私訊失敗', error); return false; }
}

export async function handleAppealCommand(command: ChatInputCommandInteraction, store: Store): Promise<void> {
  try {
    const subcommand = command.options.getSubcommand();
    if (subcommand === 'submit') {
      const original = selectedCase(store, command.user.id, command.guildId ?? undefined, command.options.getInteger('case'));
      await command.showModal(appealModal(original, command.user.id));
      return;
    }
    await acknowledge(command);
    if (subcommand === 'status') {
      const requested = command.options.getInteger('id');
      if (requested !== null) {
        const appeal = store.getAppeal(requested);
        if (!appeal || appeal.userId !== command.user.id || (command.guildId && command.guildId !== appeal.guildId)) throw new UserError(unavailable);
        const original = validCase(store, appeal.caseId, command.user.id, appeal.guildId);
        await command.editReply({ embeds: [ticketEmbed(appeal, original)], allowedMentions: noMentions });
      } else {
        const appeals = command.guildId ? store.listAppeals(command.guildId, undefined, command.user.id) : store.listUserAppeals(command.user.id);
        await respond(command, appeals.length ? appeals.map((appeal) => {
          const original = validCase(store, appeal.caseId, command.user.id, appeal.guildId);
          return `工單 #${appeal.id} · ${command.guildId ? '' : `伺服器 ${appeal.guildId} · `}案件 #${original.caseNumber} · ${statusLabels[appeal.status]}`;
        }).join('\n') : '你尚未提交申訴工單。');
      }
      return;
    }
    if (!command.guildId) throw new UserError('請在伺服器內查看待審工單或執行審核。');
    await staffGuild(command, command.guildId);
    if (subcommand === 'queue') {
      const id = command.options.getInteger('id');
      if (id !== null) {
        const appeal = store.getAppeal(id);
        if (!appeal || appeal.guildId !== command.guildId) throw new UserError('找不到此伺服器的申訴工單。');
        const original = store.getCase(appeal.caseId)!;
        await command.editReply({ embeds: [ticketEmbed(appeal, original)], allowedMentions: noMentions });
        return;
      }
      const status = command.options.getString('status') ?? 'open';
      if (status !== 'open' && status !== 'accepted' && status !== 'rejected') throw new UserError('工單狀態無效。');
      const appeals = store.listAppeals(command.guildId, status);
      await command.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`申訴工單 · ${statusLabels[status]}`)
        .setDescription(appeals.length ? appeals.map((appeal) => {
          const original = validCase(store, appeal.caseId, appeal.userId, appeal.guildId);
          return `**#${appeal.id}** · 案件 #${original.caseNumber} · <@${appeal.userId}>\n${truncate(escapeMarkdown(appeal.reason), 240)}`;
        }).join('\n\n') : '目前沒有符合條件的工單。')
        .setFooter({ text: '最多顯示最近 10 筆；使用 /appeal queue id 查看完整工單。' })], allowedMentions: noMentions });
      return;
    }
    if (subcommand === 'review') {
      const appeal = store.getAppeal(command.options.getInteger('id', true));
      if (!appeal || appeal.guildId !== command.guildId) throw new UserError('找不到此伺服器的申訴工單。');
      const result = command.options.getString('result', true);
      if (result !== 'accepted' && result !== 'rejected') throw new UserError('審核結果無效。');
      await review(command, store, appeal, result, command.options.getString('reason', true));
      return;
    }
    throw new UserError('找不到此申訴操作。');
  } catch (error) { await reportError(command, error); }
}

export async function handleAppealInteraction(interaction: Interaction, store: Store): Promise<boolean> {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return false;
  if (!interaction.customId.startsWith('appeal:')) return false;
  try {
    if (interaction.isButton()) {
      const open = /^appeal:open:([0-9]{17,20}):([0-9]{17,20})$/.exec(interaction.customId);
      if (open) {
        const guildId = open[1]!;
        if (interaction.user.id !== open[2] || (interaction.guildId && interaction.guildId !== guildId)) throw new UserError(unavailable);
        const original = selectedCase(store, interaction.user.id, guildId);
        await interaction.showModal(appealModal(original, interaction.user.id));
        return true;
      }
      const decision = /^appeal:review:([0-9]+):(accepted|rejected)$/.exec(interaction.customId);
      if (!decision) throw new UserError('申訴按鈕已失效。');
      const appeal = store.getAppeal(Number(decision[1]));
      if (!appeal || interaction.guildId !== appeal.guildId || interaction.channelId !== appeal.channelId
        || interaction.message.id !== appeal.messageId) throw new UserError('此按鈕不屬於目前的申訴工單。');
      if (appeal.status !== 'open') throw new UserError('此工單已完成審核。');
      // Opening a form makes no decision. Refresh native permissions again when it is submitted.
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new UserError('你沒有審核申訴工單的權限。');
      await interaction.showModal(reviewModal(appeal, decision[2] as ReviewResult, interaction.user.id));
      return true;
    }
    const submission = /^appeal:submit-local:([0-9]{17,20}):([0-9]{17,20})$/.exec(interaction.customId);
    if (submission) {
      await submitAppeal(interaction, store, submission[1]!, submission[2]!);
      return true;
    }
    // A form opened before the migration still contains an internal ID. Its
    // versioned route preserves that exact case rather than reinterpreting it.
    const legacySubmission = /^appeal:submit:([0-9]{17,20}):([0-9]{17,20})$/.exec(interaction.customId);
    if (legacySubmission) {
      await submitAppeal(interaction, store, legacySubmission[1]!, legacySubmission[2]!, true);
      return true;
    }
    const decision = /^appeal:decision:([0-9]+):(accepted|rejected):([0-9]{17,20})$/.exec(interaction.customId);
    if (!decision || decision[3] !== interaction.user.id) throw new UserError('審核表單已失效。');
    const appeal = store.getAppeal(Number(decision[1]));
    if (!appeal || interaction.guildId !== appeal.guildId || interaction.channelId !== appeal.channelId
      || !interaction.isFromMessage() || interaction.message.id !== appeal.messageId) {
      throw new UserError('此表單不屬於目前的申訴工單。');
    }
    await acknowledge(interaction);
    await review(interaction, store, appeal, decision[2] as ReviewResult, interaction.fields.getTextInputValue('response'));
    return true;
  } catch (error) { await reportError(interaction, error); return true; }
}
