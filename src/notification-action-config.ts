import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits,
  StringSelectMenuBuilder, type ChatInputCommandInteraction,
} from 'discord.js';
import { record } from './audit.js';
import { UserError } from './errors.js';
import { NOTICE_ACTION_LABELS, notificationActionsFor, type NoticeKind } from './notification-actions.js';
import type { Store } from './store.js';

type Command = ChatInputCommandInteraction<'cached'>;
type Draft = { initial: string[]; selected: string[] };
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
  const requested = command.options.getString('kind');
  if (requested !== null && requested !== 'management' && requested !== 'subarea') {
    throw new UserError('請選擇管理通知或子區通知。');
  }
  let kind: NoticeKind | null = requested;
  const drafts: Partial<Record<NoticeKind, Draft>> = {};
  let revision = 0;
  let savedAny = false;
  const deadline = Date.now() + panelLifetimeMs;
  let ids = controlIds();
  let visibleIds = new Set<string>();

  function controlIds() {
    const prefix = `notice-actions:${command.id}:${revision}:${kind ?? 'home'}:`;
    return { kind: `${prefix}kind`, select: `${prefix}select`, save: `${prefix}save`,
      all: `${prefix}all`, none: `${prefix}none`, cancel: `${prefix}cancel` };
  }

  function draft(selectedKind: NoticeKind): Draft {
    let value = drafts[selectedKind];
    if (!value) {
      const initial = store.getNotificationActions(command.guildId, selectedKind);
      value = { initial, selected: [...initial] };
      drafts[selectedKind] = value;
    }
    return value;
  }

  function panel(status?: string) {
    revision += 1;
    ids = controlIds();
    visibleIds = new Set([ids.kind]);
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('通知設定')
      .setDescription('先選擇通知類型，再勾選要通知的操作。可在同一張卡片切換管理通知與子區通知。')
      .setFooter({ text: '2 分鐘內完成。切換類型會保留草稿；儲存只套用目前類型，總開關與通知位置保持原設定。' });
    const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
        .setCustomId(ids.kind).setPlaceholder('選擇通知類型')
        .setMinValues(1).setMaxValues(1)
        .addOptions(
          { label: '管理通知', value: 'management', description: '處罰公告與管理日誌', default: kind === 'management' },
          { label: '子區通知', value: 'subarea', description: '操作所在子區內的通知', default: kind === 'subarea' },
        )),
    ];
    if (kind !== null) {
      const all = notificationActionsFor(kind);
      const selected = draft(kind).selected;
      const checked = new Set(selected);
      const settings = store.getSettings(command.guildId);
      embed.setTitle(`通知設定 · ${kind === 'management' ? '管理通知' : '子區通知'}`)
        .setDescription(kind === 'management'
          ? '這些項目控制處罰公告與管理日誌通知；處罰私訊另由原設定控制。'
          : '通知直接發送至實際操作的子區。')
        .addFields(
          { name: `已選取 ${selected.length}／${all.length} 項`,
            value: selected.length ? selected.map((action) => NOTICE_ACTION_LABELS[action] ?? action).join('、') : '全部不通知' },
          { name: '目前發送狀態', value: kind === 'management'
            ? `處罰公告${settings.punishmentNoticesEnabled ? '已開啟' : '已關閉'}${settings.punishmentChannelId ? ` · <#${settings.punishmentChannelId}>` : ' · 尚未設定位置'}\n管理日誌${settings.logChannelId ? ` · <#${settings.logChannelId}>` : ' · 尚未設定位置'}`
            : `子區內通知${settings.subareaNoticesEnabled ? '已開啟' : '已關閉'} · 發送至實際操作的子區` },
        );
      components.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
          .setCustomId(ids.select).setPlaceholder('選擇要通知的操作項目')
          .setMinValues(0).setMaxValues(all.length)
          .addOptions(all.map((action) => ({ label: NOTICE_ACTION_LABELS[action] ?? action,
            value: action, default: checked.has(action) })))),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(ids.save).setLabel('儲存').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(ids.all).setLabel('全選').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(ids.none).setLabel('清空').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(ids.cancel).setLabel('關閉').setStyle(ButtonStyle.Secondary),
        ),
      );
      visibleIds = new Set(Object.values(ids));
    }
    return { content: status ?? (kind === null ? '請從下方選單選擇要設定的通知。'
      : '勾選要發送通知的操作，再按「儲存」。可隨時切換下方的通知類型。'),
    embeds: [embed], components, allowedMentions: noMentions };
  }

  function closed(expired: boolean) {
    return { content: `${expired ? '通知設定面板已逾時關閉。' : '已關閉通知設定面板。'}${savedAny
      ? '已儲存的設定仍然有效；尚未儲存的變更未套用。' : '尚未儲存的變更未套用。'}`,
    embeds: [], components: [], allowedMentions: noMentions };
  }

  const message = await command.editReply(panel());
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await command.editReply(closed(true));
      return;
    }
    // Each view has new IDs. A delayed click cannot act on a different category
    // or on a newer draft rendered after the click's source message view.
    const expected = ids;
    const acceptedIds = visibleIds;
    let component;
    try {
      component = await message.awaitMessageComponent({ time: remaining,
        filter: (interaction) => interaction.user.id === command.user.id
          && interaction.guildId === command.guildId && interaction.channelId === command.channelId
          && interaction.message.id === message.id && acceptedIds.has(interaction.customId),
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'InteractionCollectorError') {
        await command.editReply(closed(true));
        return;
      }
      throw error;
    }
    if (component.customId === expected.cancel) {
      await component.update(closed(false));
      return;
    }
    if (component.customId === expected.kind) {
      if (!component.isStringSelectMenu() || component.values.length !== 1
        || (component.values[0] !== 'management' && component.values[0] !== 'subarea')) {
        await component.update({ content: '通知類型已失效，未儲存變更。', embeds: [], components: [], allowedMentions: noMentions });
        throw new UserError('請選擇管理通知或子區通知。');
      }
      await component.deferUpdate();
      await requireManager(command);
      kind = component.values[0];
      draft(kind);
      await command.editReply(panel());
      continue;
    }
    if (kind === null) throw new UserError('請先選擇通知類型。');
    const current = draft(kind);
    const all = notificationActionsFor(kind);
    if (component.customId === expected.save) {
      await component.deferUpdate();
      await requireManager(command);
      if (JSON.stringify(store.getNotificationActions(command.guildId, kind)) !== JSON.stringify(current.initial)) {
        throw new UserError('其他管理員剛剛修改了這類通知項目，未覆蓋設定；請重新開啟選單。');
      }
      if (JSON.stringify(current.selected) === JSON.stringify(current.initial)) {
        await command.editReply(panel('目前這類通知項目沒有變更，可繼續切換類型或關閉。'));
        continue;
      }
      const saved = store.setNotificationActions(command.guildId, kind, current.selected);
      current.initial = [...saved];
      current.selected = [...saved];
      savedAny = true;
      const title = kind === 'management' ? '管理通知項目' : '子區通知項目';
      const detail = `已儲存${title}：${saved.length ? saved.map((action) => NOTICE_ACTION_LABELS[action] ?? action).join('、') : '全部不通知'}。`;
      const suffix = await record(command, store, 'config', null, `更新${title}`, detail);
      await command.editReply(panel(detail + '\n可繼續切換通知類型並設定其他項目。' + suffix));
      continue;
    }
    if (component.customId === expected.all) current.selected = [...all];
    else if (component.customId === expected.none) current.selected = [];
    else if (component.customId === expected.select && component.isStringSelectMenu()) {
      try { current.selected = selectedActions(component.values, all); }
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
