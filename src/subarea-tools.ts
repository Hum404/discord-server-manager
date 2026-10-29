import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType, EmbedBuilder,
  OverwriteType, PermissionFlagsBits, escapeMarkdown,
  type ChatInputCommandInteraction, type Client, type GuildMember, type MessageContextMenuCommandInteraction,
  type OverwriteData, type TextChannel, type PublicThreadChannel, type PrivateThreadChannel,
} from 'discord.js';
import { record } from './audit.js';
import { UserError, logFailure } from './errors.js';
import { requireBotPermissions, requirePrivateThreadAccess } from './permissions.js';
import { truncate } from './presentation.js';
import { Store, type Subarea } from './store.js';

type Command = ChatInputCommandInteraction<'cached'>;
export type AreaInteraction = Command | MessageContextMenuCommandInteraction<'cached'>;
export type ManagedChannel = TextChannel | PublicThreadChannel | PrivateThreadChannel;
export interface ManagedAreaContext { actor: GuildMember; bot: GuildMember; channel: ManagedChannel; area: Subarea }
type Baseline = { id: string; type: OverwriteType; allow: string; deny: string; existed?: boolean };
const noMentions = { parse: [] as never[] };
export const LOCK_PERMISSION_BITS = PermissionFlagsBits.SendMessages | PermissionFlagsBits.SendMessagesInThreads
  | PermissionFlagsBits.CreatePublicThreads | PermissionFlagsBits.CreatePrivateThreads | PermissionFlagsBits.AddReactions;
// Keep the owner able to see the area and invoke recovery commands while it is locked.
const LOCK_CONTROL_BITS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory
  | PermissionFlagsBits.UseApplicationCommands;
const operations = new Map<string, Promise<void>>();
const toolNames = new Set(['pin', 'unpin', 'delete-message', 'slowmode', 'rename', 'lock', 'unlock', 'delete',
  'delegate', 'undelegate', 'delegates', 'info']);

/** Serialize every mutation of one area, including restrictions and ownership. */
export async function managedAreaOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  operations.set(key, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (operations.get(key) === current) operations.delete(key); }
}

export function isManagedThread(channel: { type: ChannelType }): boolean {
  return [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channel.type);
}

function administrator(actor: GuildMember): boolean {
  return actor.id === actor.guild.ownerId || actor.permissions.has(PermissionFlagsBits.Administrator);
}

/** Native thread ownership is adopted before this entry point by the thread adapter. */
export async function refreshManagedArea(
  command: AreaInteraction, store: Store, mode: 'manage' | 'owner' | 'owner-admin' = 'manage',
  channelId = command.channelId,
): Promise<ManagedAreaContext> {
  await command.guild.roles.fetch();
  const [actor, bot, candidate] = await Promise.all([
    command.guild.members.fetch({ user: command.user.id, force: true }),
    command.guild.members.fetchMe({ force: true }),
    command.guild.channels.fetch(channelId, { force: true }),
  ]);
  if (!candidate || candidate.guildId !== command.guildId
    || (candidate.type !== ChannelType.GuildText && !isManagedThread(candidate))) {
    throw new UserError('請在已登記的文字子區或討論串內使用此指令。');
  }
  const channel = candidate as ManagedChannel;
  const area = store.getSubarea(command.guildId, channel.id);
  if (!area) throw new UserError('目前頻道尚未登記為子區。');
  const owner = actor.id === area.ownerId;
  const allowed = owner || (mode !== 'owner' && administrator(actor))
    || (mode === 'manage' && !!store.getSubareaDelegate(command.guildId, channel.id, actor.id));
  if (!allowed) throw new UserError(mode === 'owner' ? '只有目前子區建立者可以執行此操作。'
    : mode === 'owner-admin' ? '只有子區建立者或伺服器管理員可以管理協管。' : '只有子區建立者、協管或伺服器管理員可以執行此操作。');
  if (!channel.permissionsFor(actor)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
    throw new UserError('你目前無法查看此子區或讀取訊息歷史。');
  }
  const privateAccess = await requirePrivateThreadAccess(channel, actor);
  if (privateAccess) throw new UserError(privateAccess);
  const latest = store.getSubarea(command.guildId, channel.id);
  const stillAllowed = latest && (actor.id === latest.ownerId || (mode !== 'owner' && administrator(actor))
    || (mode === 'manage' && !!store.getSubareaDelegate(command.guildId, channel.id, actor.id)));
  if (!stillAllowed) throw new UserError('子區建立者或協管權限已變更，未執行操作。');
  return { actor, bot, channel, area: latest };
}

function botPermissions(current: ManagedAreaContext, permissions: bigint[]): void {
  const error = requireBotPermissions(current.bot, current.channel, [PermissionFlagsBits.ViewChannel, ...permissions]);
  if (error) throw new UserError(error);
}

function readBaseline(store: Store, guildId: string, channelId: string): Baseline[] {
  const lock = store.getSubareaLock(guildId, channelId);
  return lock ? JSON.parse(lock.overwrites) as Baseline[] : [];
}

/** New restrictions must save the pre-lock baseline rather than the temporary lock denial. */
export function lockAwareRestrictionBaseline(
  store: Store, guildId: string, channelId: string, userId: string,
  current: { allow: bigint; deny: bigint } | null,
): { originalAllow: string | null; originalDeny: string | null } {
  if (!store.getSubareaLock(guildId, channelId)) {
    return { originalAllow: current?.allow.toString() ?? null, originalDeny: current?.deny.toString() ?? null };
  }
  const saved = readBaseline(store, guildId, channelId).find((entry) => entry.id === userId);
  if (!saved && !current) return { originalAllow: null, originalDeny: null };
  const allow = ((current?.allow ?? 0n) & ~LOCK_PERMISSION_BITS) | (BigInt(saved?.allow ?? '0') & LOCK_PERMISSION_BITS);
  const deny = ((current?.deny ?? 0n) & ~LOCK_PERMISSION_BITS) | (BigInt(saved?.deny ?? '0') & LOCK_PERMISSION_BITS);
  if (saved?.existed === false && allow === 0n && deny === 0n) return { originalAllow: null, originalDeny: null };
  return { originalAllow: allow.toString(), originalDeny: deny.toString() };
}

/** Keep individual unmute operations from accidentally opening a locked area. */
export function overlaySubareaLock(
  store: Store, guildId: string, channelId: string, userId: string, allow: bigint, deny: bigint,
): { allow: bigint; deny: bigint } {
  if (!store.getSubareaLock(guildId, channelId) || store.getSubarea(guildId, channelId)?.ownerId === userId) return { allow, deny };
  return { allow: allow & ~LOCK_PERMISSION_BITS, deny: deny | LOCK_PERMISSION_BITS };
}

function snapshot(channel: TextChannel, store: Store, area: Subarea, botId: string): Baseline[] {
  const entries = new Map<string, Baseline>();
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    const restriction = overwrite.type === OverwriteType.Member
      ? store.getSubareaRestriction(area.guildId, area.channelId, overwrite.id) : null;
    // Snapshot the baseline underneath a mute. Its current state is reapplied on unlock.
    const allow = restriction ? (overwrite.allow.bitfield & ~LOCK_PERMISSION_BITS)
      | (BigInt(restriction.originalAllow ?? '0') & LOCK_PERMISSION_BITS) : overwrite.allow.bitfield;
    const deny = restriction ? (overwrite.deny.bitfield & ~LOCK_PERMISSION_BITS)
      | (BigInt(restriction.originalDeny ?? '0') & LOCK_PERMISSION_BITS) : overwrite.deny.bitfield;
    entries.set(overwrite.id, { id: overwrite.id, type: overwrite.type, allow: allow.toString(), deny: deny.toString(),
      existed: restriction ? restriction.originalAllow !== null || restriction.originalDeny !== null : true });
  }
  for (const [id, type] of [[area.guildId, OverwriteType.Role], [area.ownerId, OverwriteType.Member], [botId, OverwriteType.Member]] as const) {
    if (!entries.has(id)) entries.set(id, { id, type, allow: '0', deny: '0', existed: false });
  }
  return [...entries.values()];
}

function lockedOverwrites(channel: TextChannel, area: Subarea, botId: string): OverwriteData[] {
  const entries = new Map<string, { id: string; type: OverwriteType; allow: bigint; deny: bigint }>();
  for (const overwrite of channel.permissionOverwrites.cache.values()) entries.set(overwrite.id, {
    id: overwrite.id, type: overwrite.type, allow: overwrite.allow.bitfield, deny: overwrite.deny.bitfield,
  });
  for (const [id, type] of [[area.guildId, OverwriteType.Role], [area.ownerId, OverwriteType.Member], [botId, OverwriteType.Member]] as const) {
    if (!entries.has(id)) entries.set(id, { id, type, allow: 0n, deny: 0n });
  }
  return [...entries.values()].map((entry) => {
    const exempt = entry.id === area.ownerId || entry.id === botId;
    const controlled = LOCK_PERMISSION_BITS | (exempt ? LOCK_CONTROL_BITS : 0n);
    return { ...entry, allow: exempt ? entry.allow | controlled : entry.allow & ~LOCK_PERMISSION_BITS,
      deny: exempt ? entry.deny & ~controlled : entry.deny | LOCK_PERMISSION_BITS };
  });
}

function restoredOverwrites(channel: TextChannel, store: Store, area: Subarea, botId: string): OverwriteData[] {
  const baselines = new Map(readBaseline(store, area.guildId, area.channelId).map((entry) => [entry.id, entry]));
  const ids = new Set([...channel.permissionOverwrites.cache.keys(), ...baselines.keys()]);
  const result: OverwriteData[] = [];
  for (const id of ids) {
    const current = channel.permissionOverwrites.cache.get(id);
    const baseline = baselines.get(id);
    const restriction = store.getSubareaRestriction(area.guildId, area.channelId, id);
    let originalAllow = baseline?.allow ?? restriction?.originalAllow ?? '0';
    let originalDeny = baseline?.deny ?? restriction?.originalDeny ?? '0';
    if (!baseline && restriction) {
      originalAllow = restriction.originalAllow ?? '0';
      originalDeny = restriction.originalDeny ?? '0';
    }
    const controlled = LOCK_PERMISSION_BITS | ((id === area.ownerId || id === botId) ? LOCK_CONTROL_BITS : 0n);
    let allow = ((current?.allow.bitfield ?? 0n) & ~controlled) | (BigInt(originalAllow) & controlled);
    let deny = ((current?.deny.bitfield ?? 0n) & ~controlled) | (BigInt(originalDeny) & controlled);
    if (restriction?.muted) { allow &= ~LOCK_PERMISSION_BITS; deny |= LOCK_PERMISSION_BITS; }
    const originallyPresent = baseline ? baseline.existed !== false : restriction
      ? restriction.originalAllow !== null || restriction.originalDeny !== null : !!current;
    if (allow === 0n && deny === 0n && !originallyPresent) continue;
    result.push({ id, type: current?.type ?? baseline?.type ?? OverwriteType.Member, allow, deny });
  }
  return result;
}

/** Restore durable lock policy after startup; individual restrictions are reconciled afterwards. */
export async function reconcileSubareaLocks(client: Client, store: Store): Promise<void> {
  for (const lock of store.listSubareaLocks()) {
    await managedAreaOperation(`${lock.guildId}:${lock.channelId}`, async () => {
      try {
        const guild = await client.guilds.fetch(lock.guildId);
        const channel = await guild.channels.fetch(lock.channelId, { force: true });
        if (!channel) { store.deleteSubarea(lock.guildId, lock.channelId); return; }
        if (channel.type !== ChannelType.GuildText) return;
        const area = store.getSubarea(lock.guildId, lock.channelId);
        if (!area) return;
        const bot = await guild.members.fetchMe({ force: true });
        const missing = requireBotPermissions(bot, channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageRoles]);
        if (missing) throw new UserError(missing);
        await channel.permissionOverwrites.set(lockedOverwrites(channel, area, bot.id), '恢復子區鎖定狀態');
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10003) store.deleteSubarea(lock.guildId, lock.channelId);
        else logFailure('子區鎖定恢復失敗', error);
      }
    });
  }
}

export function parseSubareaMessage(input: string, guildId: string, channelId: string): string {
  const value = input.trim();
  if (/^\d{17,20}$/.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new UserError('請提供此子區的訊息連結或訊息 ID。'); }
  const match = /^\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['discord.com', 'ptb.discord.com', 'canary.discord.com'].includes(url.hostname)
    || url.username || url.password || url.port || !match || match[1] !== guildId || match[2] !== channelId) {
    throw new UserError('訊息必須位於目前伺服器的這個子區。');
  }
  return match[3]!;
}

async function confirmation(command: AreaInteraction, label: string, stage: string): Promise<boolean> {
  const yes = `subarea-tool:${command.id}:${stage}:yes`;
  const no = `subarea-tool:${command.id}:${stage}:no`;
  const reply = await command.editReply({ content: `${label}\n請在 30 秒內確認。`, embeds: [], allowedMentions: noMentions,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(yes).setLabel('確認執行').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(no).setLabel('取消').setStyle(ButtonStyle.Secondary),
    )] });
  try {
    const button = await reply.awaitMessageComponent({ componentType: ComponentType.Button, time: 30_000,
      filter: (interaction) => interaction.user.id === command.user.id && [yes, no].includes(interaction.customId) });
    const accepted = button.customId === yes;
    await button.update({ content: accepted ? '正在核對權限…' : '已取消操作。', components: [] });
    return accepted;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'InteractionCollectorError') {
      await command.editReply({ content: '確認已逾時，未執行操作。', components: [] });
      return false;
    }
    throw error;
  }
}

/** Shared by slash commands and the selected-message APP menu; the caller owns the area lock. */
export async function mutateSubareaMessage(
  command: AreaInteraction, store: Store,
  action: 'pin' | 'unpin' | 'toggle-pin' | 'delete-message', messageId: string,
): Promise<void> {
  if (!/^\d{17,20}$/.test(messageId)) throw new UserError('請選擇有效的子區訊息。');
  const mode = action === 'delete-message' ? 'manage' : 'owner';
  let current = await refreshManagedArea(command, store, mode);
  async function selectedMessage(channel: ManagedChannel) {
    try {
      const message = await channel.messages.fetch({ message: messageId, force: true, cache: false });
      if (message.id !== messageId || message.channelId !== channel.id || message.guildId !== command.guildId) {
        throw new UserError('找不到此子區內的訊息。');
      }
      return message;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 10008) {
        throw new UserError('這則訊息已被刪除，未執行操作。');
      }
      throw error;
    }
  }
  await selectedMessage(current.channel);
  if (action === 'delete-message' && !await confirmation(command, '確定刪除此訊息？刪除後無法還原。', 'message')) return;
  current = await refreshManagedArea(command, store, mode);
  const message = await selectedMessage(current.channel);
  // Message lookup itself yields; honor ownership, delegate and private-access changes during that lookup.
  current = await refreshManagedArea(command, store, mode);
  const permission = action === 'delete-message' ? PermissionFlagsBits.ManageMessages : PermissionFlagsBits.PinMessages;
  botPermissions(current, [PermissionFlagsBits.ReadMessageHistory, permission]);
  const operation = action === 'toggle-pin' ? (message.pinned ? 'unpin' : 'pin') : action;
  if ((operation === 'pin' && message.pinned === true) || (operation === 'unpin' && message.pinned === false)) {
    await command.editReply({ content: operation === 'pin' ? '這則訊息已置頂。' : '這則訊息目前沒有置頂。',
      components: [], allowedMentions: noMentions });
    return;
  }
  if (operation === 'delete-message') await message.delete();
  else if (operation === 'pin') await message.pin(`子區建立者 ${command.user.id} 置頂`);
  else await message.unpin(`子區建立者 ${command.user.id} 取消置頂`);
  const suffix = await record(command, store, `subarea-${operation}`, null, operation === 'delete-message' ? '刪除子區訊息' : operation === 'pin' ? '置頂子區訊息' : '取消置頂子區訊息', `子區 ${current.channel.id} · 訊息 ${messageId}`, current.channel.id);
  await command.editReply({ content: (operation === 'delete-message' ? '已刪除訊息。' : operation === 'pin' ? '已置頂訊息。' : '已取消置頂訊息。') + suffix,
    components: [], allowedMentions: noMentions });
}

async function mutateMessage(command: Command, store: Store, action: 'pin' | 'unpin' | 'delete-message'): Promise<void> {
  await refreshManagedArea(command, store, action === 'delete-message' ? 'manage' : 'owner');
  const id = parseSubareaMessage(command.options.getString('message', true), command.guildId, command.channelId);
  await mutateSubareaMessage(command, store, action, id);
}

async function manageDelegates(command: Command, store: Store, action: string): Promise<void> {
  let current = await refreshManagedArea(command, store, action === 'delegates' ? 'manage' : 'owner-admin');
  if (action === 'delegates') {
    const delegates = store.listSubareaDelegates(command.guildId, current.channel.id);
    await command.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('此子區協管')
      .setDescription(delegates.length ? truncate(delegates.map((entry) => `<@${entry.userId}> · 授權者 <@${entry.grantedBy}>`).join('\n'), 3800) : '尚無協管。')
      .setFooter({ text: '協管只能管理此子區；不能再次授權、置頂、通知全體或刪除整個子區。' })], allowedMentions: noMentions });
    return;
  }
  const selected = command.options.getUser('user', true);
  if (action === 'delegate') {
    const target = await command.guild.members.fetch({ user: selected.id, force: true });
    if (target.user.bot) throw new UserError('不能授權機器人擔任協管。');
    const privateAccess = await requirePrivateThreadAccess(current.channel, target);
    if (privateAccess) throw new UserError('此成員無法存取目前的私密討論串，請先加入該討論串。');
    current = await refreshManagedArea(command, store, 'owner-admin');
    if (target.id === current.area.ownerId) throw new UserError('建立者已擁有子區管理權限。');
    if (!current.channel.permissionsFor(target)?.has(PermissionFlagsBits.ViewChannel)) throw new UserError('此成員無法查看目前子區。');
    store.setSubareaDelegate(command.guildId, current.channel.id, selected.id, current.actor.id);
  } else {
    current = await refreshManagedArea(command, store, 'owner-admin');
    store.deleteSubareaDelegate(command.guildId, current.channel.id, selected.id);
  }
  const suffix = await record(command, store, `subarea-${action}`, selected.id, action === 'delegate' ? '授予本子區協管權限' : '撤回本子區協管權限', `子區 ${current.channel.id}`, current.channel.id);
  await command.editReply({ content: `${action === 'delegate' ? '已授予' : '已撤回'} <@${selected.id}> 的本子區協管權限。${suffix}`, allowedMentions: noMentions });
}

async function editArea(command: Command, store: Store, action: string): Promise<void> {
  const current = await refreshManagedArea(command, store);
  botPermissions(current, [current.channel.type === ChannelType.GuildText ? PermissionFlagsBits.ManageChannels : PermissionFlagsBits.ManageThreads]);
  let description: string;
  if (action === 'slowmode') {
    const seconds = command.options.getInteger('seconds', true);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21_600) throw new UserError('慢速模式必須為 0 至 21600 秒。');
    await current.channel.setRateLimitPerUser(seconds, `子區管理 ${command.user.id}`);
    description = seconds === 0 ? '已關閉子區慢速模式。' : `已將子區慢速模式設為 ${seconds} 秒。`;
  } else {
    const name = command.options.getString('name', true).trim();
    if (!name || name.length > 80 || /[\p{Cc}\p{Cs}]/u.test(name)) throw new UserError('子區名稱須為 1 至 80 字且不能含控制字元。');
    await current.channel.setName(name, `子區管理 ${command.user.id}`);
    description = `已更新子區名稱為「${escapeMarkdown(name)}」。`;
  }
  const suffix = await record(command, store, `subarea-${action}`, null, description, `子區 ${current.channel.id}`, current.channel.id);
  await command.editReply({ content: description + suffix, allowedMentions: noMentions });
}

async function lockArea(command: Command, store: Store, locking: boolean, channelId: string): Promise<void> {
  const current = await refreshManagedArea(command, store, 'manage', channelId);
  const auditReason = `子區管理 ${command.user.id} ${locking ? '鎖定' : '解鎖'}`;
  if (current.channel.type !== ChannelType.GuildText) {
    botPermissions(current, [PermissionFlagsBits.ManageThreads,
      ...(locking ? [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory] : [])]);
    const existing = store.getSubareaLock(command.guildId, current.channel.id);
    if (locking) {
      // Native archived/locked flags close the thread to its creator too. A durable
      // local policy removes ordinary posts while leaving the creator's UI usable.
      if (!existing) store.setSubareaLock(command.guildId, current.channel.id, '[]', current.actor.id);
      try {
        if (current.channel.archived || current.channel.locked) {
          await current.channel.edit({ locked: false, archived: false, reason: auditReason });
        }
      } catch (error) {
        if (!existing) store.deleteSubareaLock(command.guildId, current.channel.id);
        throw error;
      }
    } else {
      // Older releases only set native flags and have no saved lock record.
      if (current.channel.archived || current.channel.locked) {
        await current.channel.edit({ locked: false, archived: false, reason: auditReason });
      }
      store.deleteSubareaLock(command.guildId, current.channel.id);
    }
  } else {
    botPermissions(current, [PermissionFlagsBits.ManageRoles]);
    const existing = store.getSubareaLock(command.guildId, current.channel.id);
    if (locking) {
      if (existing) { await command.editReply({ content: '此子區已鎖定。' }); return; }
      const baseline = snapshot(current.channel, store, current.area, current.bot.id);
      store.setSubareaLock(command.guildId, current.channel.id, JSON.stringify(baseline), current.actor.id);
      try { await current.channel.permissionOverwrites.set(lockedOverwrites(current.channel, current.area, current.bot.id), auditReason); }
      catch (error) {
        try {
          await current.channel.permissionOverwrites.set(restoredOverwrites(current.channel, store, current.area, current.bot.id), '鎖定失敗，回復原權限');
          store.deleteSubareaLock(command.guildId, current.channel.id);
        } catch (rollbackError) { logFailure('子區鎖定回復失敗，保留復原紀錄', rollbackError); }
        throw error;
      }
    } else {
      if (!existing) { await command.editReply({ content: '此子區沒有由機器人建立的鎖定紀錄，未變更權限。' }); return; }
      await current.channel.permissionOverwrites.set(restoredOverwrites(current.channel, store, current.area, current.bot.id), auditReason);
      store.deleteSubareaLock(command.guildId, current.channel.id);
      for (const restriction of store.listSubareaRestrictions(command.guildId)) {
        if (restriction.channelId === current.channel.id && !restriction.muted && !restriction.kicked) {
          store.deleteSubareaRestriction(command.guildId, current.channel.id, restriction.userId);
        }
      }
    }
  }
  const description = locking
    ? current.channel.type === ChannelType.GuildText
      ? `已鎖定子區 <#${current.channel.id}>，建立者仍可發言及使用解鎖指令。`
      : `已鎖定子區 <#${current.channel.id}>。Bot 在線時會刪除其他普通成員的新訊息與反應，建立者與管理員仍可發言。`
    : `已解鎖子區 <#${current.channel.id}>；既有個別禁言仍會保留。`;
  const suffix = await record(command, store, locking ? 'subarea-lock' : 'subarea-unlock', null, description,
    `子區 ${current.channel.id}`, current.channel.id);
  await command.editReply({ content: description + suffix, allowedMentions: noMentions });
}

async function deleteArea(command: Command, store: Store): Promise<void> {
  let current = await refreshManagedArea(command, store, 'owner');
  if (!await confirmation(command, '確定刪除整個子區及所有訊息？此操作無法還原。', 'delete-first')) return;
  current = await refreshManagedArea(command, store, 'owner');
  if (!await confirmation(command, '最後確認：按下確認將永久刪除目前子區及全部訊息。', 'delete-final')) return;
  current = await refreshManagedArea(command, store, 'owner');
  botPermissions(current, [current.channel.type === ChannelType.GuildText ? PermissionFlagsBits.ManageChannels : PermissionFlagsBits.ManageThreads]);
  await current.channel.delete(`子區建立者 ${command.user.id} 刪除`);
  try { store.deleteSubarea(command.guildId, current.channel.id); }
  catch (error) { logFailure('子區已刪除但本機清理失敗', error); }
  const suffix = await record(command, store, 'subarea-delete', command.user.id, '建立者確認刪除子區', `子區 ${current.channel.id}`, current.channel.id);
  // Discord may invalidate the interaction endpoint after its channel is deleted.
  try { await command.editReply({ content: '已刪除子區。' + suffix, components: [], allowedMentions: noMentions }); }
  catch (error) { logFailure('子區已刪除，互動回覆已失效', error); }
}

/** Archived threads may be absent from the picker, so a fixed ID or Discord link is also accepted. */
export function resolveSubareaLockTarget(command: Command): string {
  const selected = command.options.getChannel('channel');
  const supplied = command.options.getString('channel-id');
  if (selected && supplied !== null) throw new UserError('請擇一使用 channel 或 channel-id 指定子區。');
  if (supplied === null) return selected?.id ?? command.channelId;
  const input = supplied.trim();
  if (/^\d{17,20}$/.test(input)) return input;
  let url: URL;
  try { url = new URL(input); }
  catch { throw new UserError('請填寫子區 ID，或該子區的 Discord 頻道／訊息連結。'); }
  const match = /^\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['discord.com', 'ptb.discord.com', 'canary.discord.com'].includes(url.hostname)
    || url.username || url.password || url.port || !match || match[1] !== command.guildId) {
    throw new UserError('只能指定目前伺服器的 Discord 子區連結。');
  }
  return match[2]!;
}

export async function handleSubareaTools(command: Command, store: Store): Promise<boolean> {
  const action = command.options.getSubcommand();
  if (!toolNames.has(action)) return false;
  const targetId = action === 'lock' || action === 'unlock'
    ? resolveSubareaLockTarget(command) : command.channelId;
  await managedAreaOperation(`${command.guildId}:${targetId}`, async () => {
    if (action === 'pin' || action === 'unpin' || action === 'delete-message') return mutateMessage(command, store, action);
    if (action === 'delegate' || action === 'undelegate' || action === 'delegates') return manageDelegates(command, store, action);
    if (action === 'rename' || action === 'slowmode') return editArea(command, store, action);
    if (action === 'lock' || action === 'unlock') return lockArea(command, store, action === 'lock', targetId);
    if (action === 'delete') return deleteArea(command, store);
    const current = await refreshManagedArea(command, store);
    const lock = !!store.getSubareaLock(command.guildId, current.channel.id)
      || (current.channel.type !== ChannelType.GuildText && current.channel.locked && current.channel.archived);
    await command.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('子區管理資訊').addFields(
      { name: '建立者', value: `<@${current.area.ownerId}>` },
      { name: '類型', value: current.channel.type === ChannelType.GuildText ? '獨立文字頻道' : '討論串／論壇帖子' },
      { name: '協管', value: String(store.listSubareaDelegates(command.guildId, current.channel.id).length), inline: true },
      { name: '狀態', value: lock ? '已鎖定' : '未鎖定', inline: true },
      { name: '慢速模式', value: `${current.channel.rateLimitPerUser ?? 0} 秒`, inline: true },
    )], allowedMentions: noMentions });
  });
  return true;
}
