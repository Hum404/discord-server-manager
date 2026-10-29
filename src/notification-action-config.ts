import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits,
  StringSelectMenuBuilder, type ChatInputCommandInteraction,
} from 'discord.js';
import { record } from './audit.js';
import { UserError } from './errors.js';
import { NOTICE_ACTION_LABELS, notificationActionsFor, type NoticeKind } from './notification-actions.js';
import type { Store } from './store.js';

type Command = ChatInputCommandInteraction<'cached'>;
const noMentions = { parse: [] as never[] };
const panelLifetimeMs = 120_000;

async function requireManager(command: Command): Promise<void> {
  await command.guild.roles.fetch();
  const actor = await command.guild.members.fetch({ user: command.user.id, force: true });
  if (actor.id !== command.guild.ownerId && !actor.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('只有具備原生「管理伺服器」權限的管理員可以設定通知項目。');
  }
}

function selectedActions(values: readonly string[], all: readonly string[]): string[] {
  const selected = new Set(values);
  if (selected.size !== values.length || values.some((action) => !all.includes(action))) {
    throw new UserError('通知項目已失效，請重新開啟設定選單。');
  }
  return all.filter((action) => selected.has(action));
}

/** Called after the root handler has deferred an ephemeral response. */
export async function handleNotificationActionConfig(command: Command, store: Store): Promise<void> {
  await requireManager(command);
  const requested = command.options.getString('kind', true);
  if (requested !== 'management' && requested !== 'subarea') throw new UserError('請選擇管理通知或子區通知。');
  const kind: NoticeKind = requested;
  const all = notificationActionsFor(kind);
  const initial = store.getNotificationActions(command.guildId, kind);
  let selected = [...initial];
  const title = kind === 'management' ? '管理通知項目' : '子區通知項目';
  const prefix = `notice-actions:${command.id}:`;
  const ids = { select: `${prefix}select`, save: `${prefix}save`, all: `${prefix}all`, none: `${prefix}none`, cancel: `${prefix}cancel` };
  const deadline = Date.now() + panelLifetimeMs;

  function panel() {
    const checked = new Set(selected);
    return {
      content: '勾選要發送通知的操作，再按「儲存」。按「清空」可取消全部項目。',
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(title)
        .setDescription(kind === 'management'
          ? '這些項目控制處罰公告與管理日誌通知；處罰私訊另由原設定控制。'
          : '通知直接發送至實際操作的子區。')
        .addFields({ name: `已選取 ${selected.length}／${all.length} 項`,
          value: selected.length ? selected.map((action) => NOTICE_ACTION_LABELS[action] ?? action).join('、') : '全部不通知' })
        .setFooter({ text: '2 分鐘內儲存。只影響本伺服器的項目選擇；總開關與通知位置保持原設定。' })],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
          .setCustomId(ids.select).setPlaceholder('選擇要通知的操作項目')
          .setMinValues(0).setMaxValues(all.length)
          .addOptions(all.map((action) => ({ label: NOTICE_ACTION_LABELS[action] ?? action,
            value: action, default: checked.has(action) })))),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(ids.save).setLabel('儲存').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(ids.all).setLabel('全選').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(ids.none).setLabel('清空').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(ids.cancel).setLabel('取消').setStyle(ButtonStyle.Secondary),
        ),
      ], allowedMentions: noMentions,
    };
  }

  const message = await command.editReply(panel());
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await command.editReply({ content: '通知項目設定已逾時，未儲存變更。', embeds: [], components: [], allowedMentions: noMentions });
      return;
    }
    let component;
    try {
      component = await message.awaitMessageComponent({ time: remaining,
        filter: (interaction) => interaction.user.id === command.user.id
          && interaction.guildId === command.guildId && interaction.channelId === command.channelId
          && interaction.message.id === message.id && Object.values(ids).includes(interaction.customId),
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'InteractionCollectorError') {
        await command.editReply({ content: '通知項目設定已逾時，未儲存變更。', embeds: [], components: [], allowedMentions: noMentions });
        return;
      }
      throw error;
    }
    if (component.customId === ids.cancel) {
      await component.update({ content: '已取消，通知項目未變更。', embeds: [], components: [], allowedMentions: noMentions });
      return;
    }
    if (component.customId === ids.save) {
      await component.update({ content: '正在核對管理權限…', embeds: [], components: [], allowedMentions: noMentions });
      await requireManager(command);
      if (JSON.stringify(store.getNotificationActions(command.guildId, kind)) !== JSON.stringify(initial)) {
        throw new UserError('其他管理員剛剛修改了這類通知項目，未覆蓋設定；請重新開啟選單。');
      }
      const saved = store.setNotificationActions(command.guildId, kind, selected);
      const detail = `已更新${title}：${saved.length ? saved.map((action) => NOTICE_ACTION_LABELS[action] ?? action).join('、') : '全部不通知'}。`;
      const suffix = await record(command, store, 'config', null, `更新${title}`, detail);
      await command.editReply({ content: detail + '\n原本的總開關與通知位置保持原設定。' + suffix,
        embeds: [], components: [], allowedMentions: noMentions });
      return;
    }
    if (component.customId === ids.all) selected = [...all];
    else if (component.customId === ids.none) selected = [];
    else if (component.customId === ids.select && component.isStringSelectMenu()) {
      try { selected = selectedActions(component.values, all); }
      catch (error) {
        await component.update({ content: '通知項目已失效，未儲存變更。', embeds: [], components: [], allowedMentions: noMentions });
        throw error;
      }
    } else {
      await component.update({ content: '設定操作已失效，未儲存變更。', embeds: [], components: [], allowedMentions: noMentions });
      throw new UserError('通知項目選單已失效，請重新開啟。');
    }
    await component.update(panel());
  }
}
