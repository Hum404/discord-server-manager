import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  type Guild, type Interaction,
} from 'discord.js';
import { UserError, logFailure } from './errors.js';
import type { Store, SubareaLock } from './store.js';
import { changeSubareaLock } from './subarea-tools.js';

const prefix = 'subarea-unlock:';
const noMentions = { parse: [] as never[] };
const unavailable = '此解鎖按鈕已失效，或你已不是目前子區建立者；請在伺服器內重新查詢子區狀態。';

function canNotify(store: Store, guildId: string, channelId: string, lockId: string, ownerId: string): boolean {
  const current = store.getSubareaLock(guildId, channelId);
  return current?.lockId === lockId && store.getSubarea(guildId, channelId)?.ownerId === ownerId
    && store.getSettings(guildId).subareaNoticesEnabled
    && store.isNotificationActionEnabled(guildId, 'subarea', 'subarea-lock');
}

/** Persistent recovery controls bind the recipient and one specific lock generation. */
export async function notifySubareaLockOwner(
  guild: Guild, store: Store, lock: SubareaLock, ownerId: string,
): Promise<string> {
  try {
    if (guild.id !== lock.guildId || !canNotify(store, guild.id, lock.channelId, lock.lockId, ownerId)) return '';
    const owner = await guild.members.fetch({ user: ownerId, force: true });
    if (owner.id !== ownerId || owner.user.bot
      || !canNotify(store, guild.id, lock.channelId, lock.lockId, ownerId)) return '';
    const privileged = lock.source === 'admin' || lock.source === 'legacy';
    const components = privileged ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${prefix}${guild.id}:${lock.channelId}:${lock.lockId}:${ownerId}`)
        .setLabel('解鎖我的子區').setStyle(ButtonStyle.Primary),
    )];
    const state = lock.mode === 'thread-native' ? '已鎖定並封存，一般建立者也暫時無法發言' : '已鎖定';
    const instruction = privileged
      ? '這是管理員處分鎖，或來源無法確認的舊鎖；只有原生伺服器管理員可以解除，請聯絡管理員。'
      : '你可使用下方按鈕解鎖；按鈕會重新確認你的身分、子區權限及鎖定狀態。';
    await owner.send({ content: `子區 <#${lock.channelId}> ${state}。\n${instruction}`
      + `\n\n子區 ID：${lock.channelId}\n也可在同一伺服器的其他可用頻道執行：`
      + `\n\`/子區 解鎖 頻道編號:${lock.channelId}\``, components, allowedMentions: noMentions });
    return '';
  } catch (error) {
    logFailure('子區鎖定建立者私訊發送失敗', error);
    return '\n⚠️ 鎖定已完成，但建立者私訊通知發送失敗；可在其他頻道使用子區 ID 解鎖。';
  }
}

/** A global interaction route keeps these buttons usable after a Bot restart. */
export async function handleSubareaLockRecovery(interaction: Interaction, store: Store): Promise<boolean> {
  if (!interaction.isButton() || !interaction.customId.startsWith(prefix)) return false;
  let completed: string | undefined;
  try {
    // Acknowledge before any Discord lookup or permission refresh.
    await interaction.deferReply(interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {});
    const match = /^subarea-unlock:([0-9]{17,20}):([0-9]{17,20}):([a-f0-9]{16}):([0-9]{17,20})$/.exec(interaction.customId);
    if (!match) throw new UserError(unavailable);
    const guildId = match[1]!;
    const channelId = match[2]!;
    const lockId = match[3]!;
    const ownerId = match[4]!;
    if (interaction.user.id !== ownerId || (interaction.guildId !== null && interaction.guildId !== guildId)) {
      throw new UserError(unavailable);
    }
    function currentLock(): SubareaLock {
      const current = store.getSubareaLock(guildId, channelId);
      if (!current || current.lockId !== lockId || store.getSubarea(guildId, channelId)?.ownerId !== ownerId) {
        throw new UserError(unavailable);
      }
      if (current.source !== 'owner' && current.source !== 'delegate') {
        throw new UserError('此子區由管理員鎖定，或鎖定來源無法確認；請聯絡原生伺服器管理員解除。');
      }
      return current;
    }
    currentLock();
    const guild = await interaction.client.guilds.fetch(guildId);
    if (guild.id !== guildId) throw new UserError(unavailable);
    currentLock();
    completed = await changeSubareaLock({ guild, userId: interaction.user.id, channelId,
      invocationChannelId: interaction.guildId === guildId ? interaction.channelId ?? undefined : undefined },
    store, false, lockId);
    await interaction.editReply({ content: completed, allowedMentions: noMentions });
  } catch (error) {
    if (!(error instanceof UserError)) logFailure(completed !== undefined
      ? '子區解鎖結果回覆失敗' : '子區私訊解鎖失敗', error);
    const response = { content: completed !== undefined ? completed
      : error instanceof UserError ? error.message
      : '解鎖操作未能完成，請在伺服器內確認子區目前狀態後再試。', allowedMentions: noMentions };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(response);
      else await interaction.reply({ ...response, ...(interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {}) });
    } catch (replyError) { logFailure('子區私訊解鎖回覆失敗', replyError); }
  }
  return true;
}
