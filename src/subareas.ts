import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType,
  OverwriteType, PermissionFlagsBits, escapeMarkdown,
  type ChatInputCommandInteraction, type Client, type GuildBasedChannel, type GuildMember,
  type OverwriteData, type PermissionOverwriteOptions, type TextChannel,
} from 'discord.js';
import { record } from './audit.js';
import { notifyPunishment } from './appeals.js';
import { UserError, logFailure } from './errors.js';
import { requireBotPermissions } from './permissions.js';
import { truncate } from './presentation.js';
import { Store, type Subarea, type SubareaRestriction } from './store.js';
import {
  handleSubareaTools, lockAwareRestrictionBaseline, managedAreaOperation,
  overlaySubareaLock, resolveSubareaLockTarget,
} from './subarea-tools.js';
import { createThreadSubarea, ensureThreadArea, handleThreadSubarea } from './subarea-threads.js';

type Command = ChatInputCommandInteraction<'cached'>;
type Context = { actor: GuildMember; bot: GuildMember; channel: GuildBasedChannel | null };
type RestrictionAction = 'mute' | 'unmute' | 'kick' | 'unkick';
const noMentions = { parse: [] as never[] };
const permissionNames = [
  'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads',
  'CreatePrivateThreads', 'AddReactions',
] as const;
export const MUTE_PERMISSION_BITS = PermissionFlagsBits.SendMessages | PermissionFlagsBits.SendMessagesInThreads
  | PermissionFlagsBits.CreatePublicThreads | PermissionFlagsBits.CreatePrivateThreads | PermissionFlagsBits.AddReactions;
export const KICK_PERMISSION_BITS = PermissionFlagsBits.ViewChannel;
export const MANAGED_PERMISSION_BITS = MUTE_PERMISSION_BITS | KICK_PERMISSION_BITS;
const lastTags = new Map<string, number>();

/** Restore our managed bits from the baseline, preserving all other current bits. */
export function computeRestrictionPermissions(
  currentAllow: bigint, currentDeny: bigint,
  originalAllow: string | null, originalDeny: string | null,
  muted: boolean, kicked: boolean,
): { allow: bigint; deny: bigint; removeOverwrite: boolean } {
  let allow = (currentAllow & ~MANAGED_PERMISSION_BITS) | (BigInt(originalAllow ?? '0') & MANAGED_PERMISSION_BITS);
  let deny = (currentDeny & ~MANAGED_PERMISSION_BITS) | (BigInt(originalDeny ?? '0') & MANAGED_PERMISSION_BITS);
  const restricted = (muted ? MUTE_PERMISSION_BITS : 0n) | (kicked ? KICK_PERMISSION_BITS : 0n);
  allow &= ~restricted;
  deny |= restricted;
  return {
    allow, deny,
    removeOverwrite: !muted && !kicked && originalAllow === null && originalDeny === null && allow === 0n && deny === 0n,
  };
}

const exclusive = managedAreaOperation;

function isAdministrator(member: GuildMember): boolean {
  return member.id === member.guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator);
}

function assertBot(bot: GuildMember, channel: GuildBasedChannel | null, permissions: bigint[]): void {
  const error = requireBotPermissions(bot, channel, permissions);
  if (error) throw new UserError(error);
}

async function context(command: Command): Promise<Context> {
  await command.guild.roles.fetch();
  const [actor, bot, channel] = await Promise.all([
    command.guild.members.fetch({ user: command.user.id, force: true }),
    command.guild.members.fetchMe({ force: true }),
    command.guild.channels.fetch(command.channelId, { force: true }),
  ]);
  if (channel && channel.guildId !== command.guildId) throw new UserError('找不到目前伺服器的子區。');
  return { actor, bot, channel };
}

function currentArea(command: Command, store: Store, current: Context, creatorOnly = false): { area: Subarea; channel: TextChannel } {
  if (!current.channel || current.channel.type !== ChannelType.GuildText) {
    throw new UserError('請在已登記的子區文字頻道使用此指令。');
  }
  const area = store.getSubarea(command.guildId, current.channel.id);
  if (!area) throw new UserError('目前頻道不是已登記的子區。');
  const delegated = !creatorOnly && store.getSubareaDelegate(command.guildId, current.channel.id, current.actor.id) !== null;
  if (area.ownerId !== current.actor.id && !delegated && (creatorOnly || !isAdministrator(current.actor))) {
    throw new UserError(creatorOnly ? '只有目前子區的建立者可以使用提及通知功能。' : '只有此子區建立者或伺服器管理員可以執行此操作。');
  }
  if (!current.channel.permissionsFor(current.actor).has(PermissionFlagsBits.ViewChannel)) {
    throw new UserError('你目前無法查看此子區。');
  }
  return { area, channel: current.channel };
}

async function targetMember(command: Command, current: Context, area: Subarea, store: Store): Promise<GuildMember> {
  const selected = command.options.getUser('user', true);
  const target = await command.guild.members.fetch({ user: selected.id, force: true });
  if (target.id === current.actor.id || target.id === area.ownerId || target.id === current.bot.id
    || target.id === command.guild.ownerId || target.permissions.has(PermissionFlagsBits.Administrator)
    || target.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('無法限制自己、子區建立者、機器人或伺服器管理者。');
  }
  if (target.roles.highest.position >= current.bot.roles.highest.position) {
    throw new UserError('機器人的最高角色必須高於目標成員。');
  }
  if (area.ownerId !== current.actor.id && !store.getSubareaDelegate(command.guildId, area.channelId, current.actor.id)
    && current.actor.id !== command.guild.ownerId
    && target.roles.highest.position >= current.actor.roles.highest.position) {
    throw new UserError('你的最高角色必須高於目標成員。');
  }
  return target;
}

function reason(command: Command, required: boolean, fallback: string): string {
  const supplied = command.options.getString('reason', required);
  if (supplied !== null && !supplied.trim()) throw new UserError('管理原因不能為空白。');
  return supplied?.trim() ?? fallback;
}

function permissionPatch(allow: bigint, deny: bigint): PermissionOverwriteOptions {
  const patch: PermissionOverwriteOptions = {};
  for (const name of permissionNames) {
    const flag = PermissionFlagsBits[name];
    patch[name] = (allow & flag) !== 0n ? true : (deny & flag) !== 0n ? false : null;
  }
  return patch;
}

async function writeRestrictionPermissions(channel: TextChannel, store: Store, state: SubareaRestriction, auditReason: string): Promise<void> {
  const existing = channel.permissionOverwrites.cache.get(state.userId);
  const permissions = computeRestrictionPermissions(existing?.allow.bitfield ?? 0n, existing?.deny.bitfield ?? 0n,
    state.originalAllow, state.originalDeny, state.muted, state.kicked);
  const overlay = overlaySubareaLock(store, state.guildId, state.channelId, state.userId, permissions.allow, permissions.deny);
  if (permissions.removeOverwrite && !store.getSubareaLock(state.guildId, state.channelId)) {
    if (existing) await channel.permissionOverwrites.delete(state.userId, auditReason);
  } else {
    await channel.permissionOverwrites.edit(state.userId, permissionPatch(overlay.allow, overlay.deny), {
      type: OverwriteType.Member, reason: auditReason,
    });
  }
}

async function applyRestriction(
  command: Command, store: Store, channel: TextChannel, target: GuildMember,
  action: RestrictionAction, explanation: string,
): Promise<string> {
  const previous = store.getSubareaRestriction(command.guildId, channel.id, target.id);
  const original = channel.permissionOverwrites.cache.get(target.id);
  const baseline = lockAwareRestrictionBaseline(store, command.guildId, channel.id, target.id,
    original ? { allow: original.allow.bitfield, deny: original.deny.bitfield } : null);
  const muted = action === 'mute' ? true : action === 'unmute' ? false : previous?.muted ?? false;
  const kicked = action === 'kick' ? true : action === 'unkick' ? false : previous?.kicked ?? false;
  const state = store.setSubareaRestriction({
    guildId: command.guildId, channelId: channel.id, userId: target.id, muted, kicked,
    originalAllow: previous ? previous.originalAllow : baseline.originalAllow,
    originalDeny: previous ? previous.originalDeny : baseline.originalDeny,
    moderatorId: command.user.id, reason: explanation,
  });
  try {
    await writeRestrictionPermissions(channel, store, state, truncate(`${command.user.id}：${explanation}`, 512));
  } catch (error) {
    try {
      if (previous) store.setSubareaRestriction(previous);
      else store.deleteSubareaRestriction(command.guildId, channel.id, target.id);
    } catch (rollbackError) {
      logFailure('子區限制資料回復失敗', rollbackError);
    }
    throw error;
  }
  if (!muted && !kicked && !store.getSubareaLock(command.guildId, channel.id)) {
    try { store.deleteSubareaRestriction(command.guildId, channel.id, target.id); }
    catch (error) {
      logFailure('子區限制已解除但本機紀錄清理失敗', error);
      return '\n⚠️ 權限已還原，但本機紀錄清理失敗，重新啟動後會再次核對。';
    }
  }
  return '';
}

async function confirmKick(command: Command, userId: string): Promise<boolean> {
  const yes = `subarea:kick:${command.id}`;
  const no = `subarea:cancel:${command.id}`;
  const message = await command.editReply({
    content: `確定要禁止 <@${userId}> 查看及進入目前子區？這不會將對方踢出伺服器。\n請在 30 秒內確認。`,
    allowedMentions: noMentions,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(yes).setLabel('確認移出子區').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(no).setLabel('取消').setStyle(ButtonStyle.Secondary),
    )],
  });
  let button;
  try {
    button = await message.awaitMessageComponent({ componentType: ComponentType.Button, time: 30_000,
      filter: (interaction) => interaction.user.id === command.user.id && [yes, no].includes(interaction.customId) });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'InteractionCollectorError') {
      await command.editReply({ content: '確認已逾時，未修改子區權限。', components: [] });
      return false;
    }
    throw error;
  }
  const accepted = button.customId === yes;
  await button.update({ content: accepted ? '正在更新子區權限…' : '已取消操作。', components: [] });
  return accepted;
}

function mentionPolicy(channel: { permissionOverwrites: { cache: TextChannel['permissionOverwrites']['cache'] } }, ownerId: string, botId: string, everyoneId: string): OverwriteData[] {
  const overwrites = new Map<string, OverwriteData>();
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    overwrites.set(overwrite.id, { id: overwrite.id, type: overwrite.type,
      allow: overwrite.allow.bitfield & ~PermissionFlagsBits.MentionEveryone,
      deny: overwrite.deny.bitfield | PermissionFlagsBits.MentionEveryone });
  }
  if (!overwrites.has(everyoneId)) {
    overwrites.set(everyoneId, { id: everyoneId, type: OverwriteType.Role, allow: 0n, deny: PermissionFlagsBits.MentionEveryone });
  }
  const owner = overwrites.get(ownerId);
  const ownerAllowed = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory
    | PermissionFlagsBits.MentionEveryone;
  overwrites.set(ownerId, { id: ownerId, type: OverwriteType.Member,
    allow: BigInt(owner?.allow as bigint ?? 0n) | ownerAllowed,
    deny: BigInt(owner?.deny as bigint ?? 0n) & ~ownerAllowed });
  const bot = overwrites.get(botId);
  const botAllowed = ownerAllowed | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles | PermissionFlagsBits.EmbedLinks;
  overwrites.set(botId, { id: botId, type: OverwriteType.Member,
    allow: BigInt(bot?.allow as bigint ?? 0n) | botAllowed,
    deny: BigInt(bot?.deny as bigint ?? 0n) & ~botAllowed });
  return [...overwrites.values()];
}

async function pruneDeletedAreas(command: Command, store: Store): Promise<Subarea[]> {
  const found: Subarea[] = [];
  for (const area of store.listSubareas(command.guildId, command.user.id)) {
    try {
      const channel = await command.guild.channels.fetch(area.channelId, { force: true });
      if (!channel || (channel.type !== ChannelType.GuildText && !channel.isThread())) store.deleteSubarea(area.guildId, area.channelId);
      else found.push(area);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 10003) {
        store.deleteSubarea(area.guildId, area.channelId);
      } else throw error;
    }
  }
  return found;
}

async function createArea(command: Command, store: Store): Promise<void> {
  await exclusive(`${command.guildId}:create:${command.user.id}`, async () => {
    let current = await context(command);
    const categoryId = store.getSettings(command.guildId).subareaCategoryId;
    if (!categoryId) throw new UserError('管理員尚未開放建立子區，請先設定 /config subareas。');
    let category = await command.guild.channels.fetch(categoryId, { force: true });
    if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== command.guildId) {
      throw new UserError('子區分類已不存在，請管理員重新設定。');
    }
    if (!category.permissionsFor(current.actor).has(PermissionFlagsBits.ViewChannel)) {
      throw new UserError('你無法查看這個子區分類。');
    }
    assertBot(current.bot, null, [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.MentionEveryone]);
    assertBot(current.bot, category, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]);
    if ((await pruneDeletedAreas(command, store)).length >= 3) throw new UserError('每位用戶最多保留 3 個子區，請先請管理員刪除不再使用的子區。');
    current = await context(command);
    category = await command.guild.channels.fetch(categoryId, { force: true });
    if (store.getSettings(command.guildId).subareaCategoryId !== categoryId
      || !category || category.type !== ChannelType.GuildCategory
      || !category.permissionsFor(current.actor).has(PermissionFlagsBits.ViewChannel)) {
      throw new UserError('子區分類設定或你的查看權限已變更，未建立子區。');
    }
    assertBot(current.bot, null, [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.MentionEveryone]);
    assertBot(current.bot, category, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]);
    const name = command.options.getString('name', true).trim();
    if (!name) throw new UserError('子區名稱不能為空白。');
    const channel = await command.guild.channels.create({
      name, type: ChannelType.GuildText, parent: category.id,
      permissionOverwrites: mentionPolicy(category, current.actor.id, current.bot.id, command.guild.id),
      reason: truncate(`子區建立者 ${current.actor.id}`, 512),
    });
    try { store.setSubarea(command.guildId, channel.id, current.actor.id); }
    catch (error) {
      try { await channel.delete('子區資料儲存失敗，回復建立操作'); }
      catch (rollbackError) { logFailure('新子區回復刪除失敗', rollbackError); }
      throw error;
    }
    const suffix = await record(command, store, 'subarea-create', current.actor.id, '建立子區', `子區 ${channel.id}`, channel.id);
    await command.editReply({ content: `已建立子區 <#${channel.id}>，建立者可使用 /subarea 管理此頻道。${suffix}`, allowedMentions: noMentions });
  });
}

async function assignArea(command: Command, store: Store): Promise<void> {
  const selected = command.options.getChannel('channel', true);
  await exclusive(`${command.guildId}:${selected.id}`, async () => {
    const current = await context(command);
    if (!isAdministrator(current.actor)) throw new UserError('只有伺服器管理員可以指派子區建立者。');
    const channel = await command.guild.channels.fetch(selected.id, { force: true });
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== command.guildId) {
      throw new UserError('只能指派本伺服器的文字頻道。');
    }
    if (store.getSubareaLock(command.guildId, channel.id)) {
      throw new UserError('此子區正在鎖定，請先 /subarea unlock 再轉移建立者。');
    }
    assertBot(current.bot, channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ManageRoles, PermissionFlagsBits.MentionEveryone]);
    const owner = await command.guild.members.fetch({ user: command.options.getUser('user', true).id, force: true });
    if (owner.user.bot) throw new UserError('請選擇一般用戶作為子區建立者。');
    const verified = await context(command);
    if (!isAdministrator(verified.actor)) throw new UserError('你的管理員權限已變更，未指派子區建立者。');
    const previousArea = store.getSubarea(command.guildId, channel.id);
    const previousDelegates = previousArea ? store.listSubareaDelegates(command.guildId, channel.id) : [];
    const previousRestriction = store.getSubareaRestriction(command.guildId, channel.id, owner.id);
    const previousOverwrites = channel.permissionOverwrites.cache.map((overwrite) => ({ id: overwrite.id,
      type: overwrite.type, allow: overwrite.allow.bitfield, deny: overwrite.deny.bitfield }));
    try {
      if (previousRestriction) await writeRestrictionPermissions(channel, store, { ...previousRestriction, muted: false, kicked: false }, '指派新建立者，解除其舊子區限制');
      // Fetch again because overwrite editing uses REST and need not update its cache.
      const refreshed = await command.guild.channels.fetch(channel.id, { force: true });
      if (!refreshed || refreshed.type !== ChannelType.GuildText) throw new UserError('子區已不存在。');
      const authorized = await context(command);
      if (!isAdministrator(authorized.actor)) throw new UserError('你的管理員權限已變更，未指派子區建立者。');
      assertBot(authorized.bot, refreshed, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageRoles, PermissionFlagsBits.MentionEveryone]);
      await refreshed.permissionOverwrites.set(mentionPolicy(refreshed, owner.id, authorized.bot.id, command.guildId), `管理員 ${authorized.actor.id} 指派子區建立者`);
      const persistedAuthority = await context(command);
      if (!isAdministrator(persistedAuthority.actor)) throw new UserError('你的管理員權限已變更，已取消子區建立者指派。');
      store.setSubarea(command.guildId, channel.id, owner.id);
      if (previousRestriction) store.deleteSubareaRestriction(command.guildId, channel.id, owner.id);
    } catch (error) {
      try { await channel.permissionOverwrites.set(previousOverwrites, '指派失敗，回復原有權限'); }
      catch (rollbackError) { logFailure('子區建立者指派權限回復失敗', rollbackError); }
      try {
        if (previousArea) store.setSubarea(command.guildId, channel.id, previousArea.ownerId);
        else store.deleteSubarea(command.guildId, channel.id);
        if (previousArea) for (const delegate of previousDelegates) {
          store.setSubareaDelegate(delegate.guildId, delegate.channelId, delegate.userId, delegate.grantedBy);
        }
        if (previousRestriction) store.setSubareaRestriction(previousRestriction);
      } catch (rollbackError) { logFailure('子區建立者指派資料回復失敗', rollbackError); }
      throw error;
    }
    const suffix = await record(command, store, 'subarea-assign', owner.id, '指派子區建立者', `子區 ${channel.id}`, channel.id);
    await command.editReply({ content: `已將 <#${channel.id}> 的建立者設定為 <@${owner.id}>。${suffix}`, allowedMentions: noMentions });
  });
}

async function moderateArea(command: Command, store: Store, action: RestrictionAction): Promise<void> {
  let current = await context(command);
  let registered = currentArea(command, store, current);
  let target = await targetMember(command, current, registered.area, store);
  assertBot(current.bot, registered.channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageRoles]);
  const previous = store.getSubareaRestriction(command.guildId, registered.channel.id, target.id);
  if ((action === 'mute' && previous?.muted) || (action === 'kick' && previous?.kicked)) {
    await command.editReply({ content: action === 'mute' ? '此用戶已在本子區禁言。' : '此用戶已被禁止進入本子區。' });
    return;
  }
  if ((action === 'unmute' && !previous?.muted) || (action === 'unkick' && !previous?.kicked)) {
    await command.editReply({ content: action === 'unmute' ? '此用戶目前沒有本子區禁言限制。' : '此用戶目前沒有本子區進入限制。' });
    return;
  }
  const explanation = reason(command, action === 'mute' || action === 'kick', action === 'unmute' ? '解除子區禁言' : '解除子區進入限制');
  if (action === 'kick' && !await confirmKick(command, target.id)) return;
  // Confirmation and DM delivery both allow roles/ownership to change externally.
  current = await context(command);
  registered = currentArea(command, store, current);
  target = await targetMember(command, current, registered.area, store);
  let notified = true;
  if (action === 'mute' || action === 'kick') {
    notified = await notifyPunishment(target, `subarea-${action}`, explanation, store);
    current = await context(command);
    registered = currentArea(command, store, current);
    target = await targetMember(command, current, registered.area, store);
  }
  assertBot(current.bot, registered.channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageRoles]);
  registered = currentArea(command, store, current);
  const warning = await applyRestriction(command, store, registered.channel, target, action, explanation);
  const suffix = await record(command, store, `subarea-${action}`, target.id, explanation, `子區 ${registered.channel.id}`);
  const result = action === 'mute' ? `已禁止 <@${target.id}> 在本子區發言。`
    : action === 'unmute' ? `已解除 <@${target.id}> 的本子區禁言。`
      : action === 'kick' ? `已禁止 <@${target.id}> 查看及進入本子區。` : `已解除 <@${target.id}> 的本子區進入限制。`;
  await command.editReply({ content: result + warning + suffix + (notified ? '' : '\n⚠️ 無法私訊申訴入口，對方仍可用 /appeal 提交申訴。'),
    components: [], allowedMentions: noMentions });
}

async function tagArea(command: Command, store: Store, kind: 'tag' | 'role-tag' | 'announce'): Promise<void> {
  const current = await context(command);
  const { channel } = currentArea(command, store, current, true);
  const key = `${command.guildId}:${channel.id}:${current.actor.id}`;
  const now = Date.now();
  if (now - (lastTags.get(key) ?? 0) < 30_000) throw new UserError('每個子區每 30 秒只能使用一次提及通知，請稍後再試。');
  if (lastTags.size > 2000) for (const [saved, timestamp] of lastTags) if (now - timestamp >= 30_000) lastTags.delete(saved);
  assertBot(current.bot, channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    ...(kind === 'tag' ? [] : [PermissionFlagsBits.MentionEveryone])]);
  const message = command.options.getString('message', kind === 'announce')?.trim();
  if (kind === 'announce' && !message) throw new UserError('通知內容不能為空白。');
  let content: string;
  let userId: string | null = null;
  let allowedMentions: { parse: Array<'everyone'>; users?: string[]; roles?: string[] };
  if (kind === 'tag') {
    const user = command.options.getUser('user', true);
    const member = await command.guild.members.fetch({ user: user.id, force: true });
    if (!channel.permissionsFor(member).has(PermissionFlagsBits.ViewChannel)) throw new UserError('此成員無法查看目前子區。');
    userId = user.id;
    content = `<@${user.id}>${message ? ` ${message}` : ''}`;
    allowedMentions = { parse: [], users: [user.id] };
  } else if (kind === 'role-tag') {
    const role = command.options.getRole('role', true);
    if (role.id === command.guildId) throw new UserError('請使用 /subarea announce 標註 everyone。');
    content = `<@&${role.id}>${message ? ` ${message}` : ''}`;
    allowedMentions = { parse: [], roles: [role.id] };
  } else {
    const audience = command.options.getString('audience', true);
    if (audience !== 'everyone' && audience !== 'here') throw new UserError('通知對象格式無效。');
    content = `@${audience} ${message}`;
    allowedMentions = { parse: ['everyone'] };
  }
  // Check current owner again after asynchronous member resolution before sending.
  if (store.getSubarea(command.guildId, channel.id)?.ownerId !== command.user.id) throw new UserError('子區建立者已變更，未發送提及通知。');
  await channel.send({ content, allowedMentions });
  lastTags.set(key, Date.now());
  const suffix = await record(command, store, 'subarea-tag', userId, '子區建立者提及通知', `子區 ${channel.id}；類型 ${kind}`);
  await command.editReply({ content: `已在本子區發送提及通知。${suffix}`, allowedMentions: noMentions });
}

export async function handleSubareaCommand(command: Command, store: Store): Promise<void> {
  const action = command.options.getSubcommand();
  if (action === 'create') {
    const kind = command.options.getString('type');
    if (kind === 'thread' || kind === 'forum') return createThreadSubarea(command, store);
    if (kind !== null && kind !== 'text') throw new UserError('請選擇文字頻道、討論串或論壇帖子。');
    return createArea(command, store);
  }
  const managementTarget = action === 'lock' || action === 'unlock' ? resolveSubareaLockTarget(command) : command.channelId;
  await ensureThreadArea(command, store, managementTarget);
  if (await handleSubareaTools(command, store)) return;
  if (await handleThreadSubarea(command, store)) return;
  if (action === 'assign') return assignArea(command, store);
  if (action === 'list') {
    const areas = await pruneDeletedAreas(command, store);
    await command.editReply({ content: areas.length ? areas.map((area) => `<#${area.channelId}>`).join('\n') : '你目前沒有已登記的子區。', allowedMentions: noMentions });
    return;
  }
  await exclusive(`${command.guildId}:${command.channelId}`, async () => {
    if (action === 'tag' || action === 'role-tag' || action === 'announce') return tagArea(command, store, action);
    if (action === 'mute' || action === 'unmute' || action === 'kick' || action === 'unkick') return moderateArea(command, store, action);
    throw new UserError('找不到此子區管理功能。');
  });
}

export function handleSubareaChannelDelete(channel: GuildBasedChannel, store: Store): void {
  store.deleteSubarea(channel.guildId, channel.id);
}

/** Complete durable permission changes if the process stopped between SQLite and REST. */
export async function reconcileSubareaRestrictions(client: Client, store: Store): Promise<void> {
  for (const state of store.listSubareaRestrictions()) {
    await exclusive(`${state.guildId}:${state.channelId}`, async () => {
      try {
        const guild = await client.guilds.fetch(state.guildId);
        const channel = await guild.channels.fetch(state.channelId, { force: true });
        if (!channel) {
          store.deleteSubarea(state.guildId, state.channelId);
          return;
        }
        if (channel.isThread()) return; // Thread restrictions are enforced by message/reaction events.
        if (channel.type !== ChannelType.GuildText) return;
        const latest = store.getSubareaRestriction(state.guildId, state.channelId, state.userId);
        if (!latest || latest.userId === client.user?.id) return;
        const bot = await guild.members.fetchMe({ force: true });
        assertBot(bot, channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageRoles]);
        await writeRestrictionPermissions(channel, store, latest, '重新啟動後核對子區權限');
        if (!latest.muted && !latest.kicked && !store.getSubareaLock(latest.guildId, latest.channelId)) {
          store.deleteSubareaRestriction(latest.guildId, latest.channelId, latest.userId);
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10003) {
          store.deleteSubarea(state.guildId, state.channelId);
        } else logFailure('重新核對子區權限失敗', error);
      }
    });
  }
}
