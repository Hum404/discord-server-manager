import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType, PermissionFlagsBits,
  type ChatInputCommandInteraction, type GuildBasedChannel, type GuildMember, type Message,
  type MessageReaction, type PartialMessageReaction, type PartialUser, type ThreadChannel, type User,
  type PublicThreadChannel, type PrivateThreadChannel,
} from 'discord.js';
import { record } from './audit.js';
import { notifyPunishment } from './appeals.js';
import { logFailure, UserError } from './errors.js';
import { requireBotPermissions, requirePrivateThreadAccess } from './permissions.js';
import { truncate } from './presentation.js';
import { Store, type Subarea } from './store.js';
import { managedAreaOperation, type AreaInteraction } from './subarea-tools.js';

type Command = ChatInputCommandInteraction<'cached'>;
type ManagedThread = PublicThreadChannel | PrivateThreadChannel;
type ThreadContext = { actor: GuildMember; bot: GuildMember; channel: ManagedThread; area: Subarea };
const noMentions = { parse: [] as never[] };
const lastNotice = new Map<string, number>();
const lastTag = new Map<string, number>();

export function isSubareaThread(channel: { type: number } | null | undefined): channel is ManagedThread {
  return channel?.type === ChannelType.PublicThread || channel?.type === ChannelType.PrivateThread
    || channel?.type === ChannelType.AnnouncementThread;
}

function administrator(member: GuildMember): boolean {
  return member.id === member.guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator);
}

function botPermissions(bot: GuildMember, channel: GuildBasedChannel, flags: bigint[]): void {
  const error = requireBotPermissions(bot, channel, flags);
  if (error) throw new UserError(error);
}

/** Existing human-created posts need no administrator registration command. */
export async function ensureThreadArea(command: AreaInteraction, store: Store, channelId = command.channelId): Promise<void> {
  const channel = await command.guild.channels.fetch(channelId, { force: true });
  if (!isSubareaThread(channel) || channel.guildId !== command.guildId
    || store.getSubarea(command.guildId, channel.id) || !channel.ownerId) return;
  let owner: GuildMember;
  try { owner = await command.guild.members.fetch({ user: channel.ownerId, force: true }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 10007) return;
    throw error;
  }
  if (owner.user.bot) return;
  // A concurrent assignment wins; it must not be silently reverted by discovery.
  if (!store.getSubarea(command.guildId, channel.id)) store.setSubarea(command.guildId, channel.id, owner.id);
}

function assertAuthority(current: ThreadContext, command: Command, store: Store, creatorOnly = false): Subarea {
  const area = store.getSubarea(command.guildId, current.channel.id);
  if (!area) throw new UserError('這個討論串尚未登記為子區，請由建立者使用指令，或請管理員指派。');
  if (area.ownerId !== current.actor.id && (creatorOnly
    || (!administrator(current.actor) && !store.getSubareaDelegate(command.guildId, area.channelId, current.actor.id)))) {
    throw new UserError(creatorOnly ? '只有目前子區建立者可以使用提及通知。' : '只有此子區建立者、協管或伺服器管理員可以執行此操作。');
  }
  if (!current.channel.permissionsFor(current.actor)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new UserError('你目前無法查看此子區。');
  }
  return area;
}

async function context(command: Command, store: Store, creatorOnly = false): Promise<ThreadContext> {
  await command.guild.roles.fetch();
  const [actor, bot, channel] = await Promise.all([
    command.guild.members.fetch({ user: command.user.id, force: true }),
    command.guild.members.fetchMe({ force: true }),
    command.guild.channels.fetch(command.channelId, { force: true }),
  ]);
  if (!isSubareaThread(channel) || channel.guildId !== command.guildId) throw new UserError('請在討論串或論壇帖子內使用此功能。');
  const privateAccess = await requirePrivateThreadAccess(channel, actor);
  if (privateAccess) throw new UserError(privateAccess);
  const area = store.getSubarea(command.guildId, channel.id);
  if (!area) throw new UserError('此討論串尚未登記，請由原建立者使用指令，或請管理員指派。');
  const result = { actor, bot, channel, area };
  result.area = assertAuthority(result, command, store, creatorOnly);
  return result;
}

function assertTarget(current: ThreadContext, target: GuildMember): void {
  if (target.id === current.actor.id || target.id === current.area.ownerId || target.user.bot
    || target.id === current.channel.guild.ownerId || target.permissions.has(PermissionFlagsBits.Administrator)
    || target.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('不能限制自己、子區建立者、機器人或伺服器管理者。');
  }
}

function explanation(command: Command, required: boolean, fallback: string): string {
  const value = command.options.getString('reason', required)?.trim();
  if (value === '') throw new UserError('請填寫管理原因。');
  return value ?? fallback;
}

async function confirmRemoval(command: Command, userId: string): Promise<boolean> {
  const yes = `thread:remove:${command.id}`;
  const no = `thread:cancel:${command.id}`;
  const message = await command.editReply({
    content: `確定要將 <@${userId}> 從本討論串的成員列表移除？公開討論串仍可查看或重新加入。這不會踢出伺服器。\n請在 30 秒內確認。`,
    allowedMentions: noMentions,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(yes).setLabel('確認移除成員').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(no).setLabel('取消').setStyle(ButtonStyle.Secondary),
    )],
  });
  let button;
  try {
    button = await message.awaitMessageComponent({ componentType: ComponentType.Button, time: 30_000,
      filter: (interaction) => interaction.user.id === command.user.id && [yes, no].includes(interaction.customId) });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'InteractionCollectorError') {
      await command.editReply({ content: '確認已逾時，未移除成員。', components: [] });
      return false;
    }
    throw error;
  }
  const accepted = button.customId === yes;
  await button.update({ content: accepted ? '正在移除討論串成員…' : '已取消操作。', components: [] });
  return accepted;
}

async function moderate(command: Command, store: Store, action: 'mute' | 'unmute' | 'kick' | 'unkick'): Promise<void> {
  let current = await context(command, store);
  const userId = command.options.getUser('user', true).id;
  let target = await command.guild.members.fetch({ user: userId, force: true });
  current.area = assertAuthority(current, command, store);
  assertTarget(current, target);
  const reason = explanation(command, action === 'mute' || action === 'kick', action === 'unmute' ? '解除討論串禁言' : '重新加入討論串');
  const previous = store.getSubareaRestriction(command.guildId, current.channel.id, userId);
  if ((action === 'mute' && previous?.muted) || (action === 'unmute' && !previous?.muted)) {
    await command.editReply({ content: action === 'mute' ? '此成員已在本討論串禁言。' : '此成員目前沒有本討論串禁言限制。' });
    return;
  }
  botPermissions(current.bot, current.channel, [PermissionFlagsBits.ViewChannel,
    action === 'mute' || action === 'unmute' ? PermissionFlagsBits.ManageMessages : PermissionFlagsBits.ManageThreads]);
  if (action === 'kick' && !await confirmRemoval(command, userId)) return;
  let notified = true;
  if (action === 'mute' || action === 'kick') notified = await notifyPunishment(target, `subarea-${action}`, reason);
  current = await context(command, store);
  target = await command.guild.members.fetch({ user: userId, force: true });
  current.area = assertAuthority(current, command, store);
  assertTarget(current, target);
  botPermissions(current.bot, current.channel, [PermissionFlagsBits.ViewChannel,
    action === 'mute' || action === 'unmute' ? PermissionFlagsBits.ManageMessages : PermissionFlagsBits.ManageThreads]);
  let result: string;
  if (action === 'mute') {
    store.setSubareaRestriction({ guildId: command.guildId, channelId: current.channel.id, userId,
      muted: true, kicked: false, originalAllow: null, originalDeny: null, moderatorId: command.user.id, reason });
    result = `已在本討論串禁言 <@${userId}>。機器人在線時會刪除其在本帖的新訊息及反應，不影響其他頻道。`;
  } else if (action === 'unmute') {
    store.deleteSubareaRestriction(command.guildId, current.channel.id, userId);
    result = `已解除 <@${userId}> 的本討論串禁言。`;
  } else if (action === 'kick') {
    await current.channel.members.remove(userId, truncate(`${command.user.id}：${reason}`, 512));
    result = `已將 <@${userId}> 從本討論串成員列表移除。公開討論串仍可查看或重新加入；這不是禁止存取。`;
  } else {
    await current.channel.members.add(userId, truncate(`${command.user.id}：${reason}`, 512));
    result = `已將 <@${userId}> 加回本討論串。這不會改動其伺服器或父頻道權限。`;
  }
  const suffix = await record(command, store, `subarea-${action}`, userId, reason, `討論串 ${current.channel.id}`);
  await command.editReply({ content: result + suffix + (notified ? '' : '\n⚠️ 私訊通知失敗，請另行通知當事人申訴方式。'),
    components: [], allowedMentions: noMentions });
}

async function tag(command: Command, store: Store, kind: 'tag' | 'role-tag' | 'announce'): Promise<void> {
  let current = await context(command, store, true);
  const key = `${command.guildId}:${current.channel.id}:${current.actor.id}`;
  if (Date.now() - (lastTag.get(key) ?? 0) < 30_000) throw new UserError('每個子區每 30 秒只能使用一次提及通知。');
  botPermissions(current.bot, current.channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads,
    ...(kind === 'tag' ? [] : [PermissionFlagsBits.MentionEveryone])]);
  const message = command.options.getString('message', kind === 'announce')?.trim();
  if (kind === 'announce' && !message) throw new UserError('請填寫通知內容。');
  let content: string;
  let mentionedUser: string | null = null;
  let allowedMentions: { parse: Array<'everyone'>; users?: string[]; roles?: string[] };
  if (kind === 'tag') {
    const userId = command.options.getUser('user', true).id;
    const member = await command.guild.members.fetch({ user: userId, force: true });
    if (!current.channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) throw new UserError('此成員無法查看目前子區。');
    const privateAccess = await requirePrivateThreadAccess(current.channel, member);
    if (privateAccess) throw new UserError('此成員無法存取目前的私密討論串。');
    content = `<@${userId}>${message ? ` ${message}` : ''}`;
    mentionedUser = userId;
    allowedMentions = { parse: [], users: [userId] };
  } else if (kind === 'role-tag') {
    const selected = command.options.getRole('role', true);
    if (selected.id === command.guildId) throw new UserError('請使用 announce 通知 everyone。');
    const role = await command.guild.roles.fetch(selected.id);
    if (!role) throw new UserError('找不到此伺服器身分組。');
    content = `<@&${role.id}>${message ? ` ${message}` : ''}`;
    allowedMentions = { parse: [], roles: [role.id] };
  } else {
    const audience = command.options.getString('audience', true);
    if (audience !== 'everyone' && audience !== 'here') throw new UserError('無效的通知對象。');
    content = `@${audience} ${message}`;
    allowedMentions = { parse: ['everyone'] };
  }
  // Target/role lookup can yield; a former creator cannot use a queued notice.
  current = await context(command, store, true);
  botPermissions(current.bot, current.channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads,
    ...(kind === 'tag' ? [] : [PermissionFlagsBits.MentionEveryone])]);
  assertAuthority(current, command, store, true);
  await current.channel.send({ content, allowedMentions });
  const now = Date.now();
  lastTag.set(key, now);
  if (lastTag.size > 2000) for (const [saved, time] of lastTag) if (now - time >= 30_000) lastTag.delete(saved);
  const suffix = await record(command, store, `subarea-${kind}`, mentionedUser, '建立者發送提及通知', `討論串 ${current.channel.id}`);
  await command.editReply({ content: `已發送提及通知。${suffix}`, allowedMentions: noMentions });
}

async function assign(command: Command, store: Store, channelId: string): Promise<void> {
  await command.guild.roles.fetch();
  let actor = await command.guild.members.fetch({ user: command.user.id, force: true });
  if (!administrator(actor)) throw new UserError('只有伺服器管理員可以指派討論串建立者。');
  let channel = await command.guild.channels.fetch(channelId, { force: true });
  if (!isSubareaThread(channel) || channel.guildId !== command.guildId) throw new UserError('找不到此伺服器的討論串。');
  const owner = await command.guild.members.fetch({ user: command.options.getUser('user', true).id, force: true });
  if (owner.user.bot) throw new UserError('請選擇一般用戶作為建立者。');
  const nativeOwner = channel.ownerId ? await command.guild.members.fetch({ user: channel.ownerId, force: true }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 10007) return null;
    throw error;
  }) : null;
  if (nativeOwner && !nativeOwner.user.bot && nativeOwner.id !== owner.id) {
    throw new UserError('真人建立的討論串只能登記原帖主；若要授權他人，請使用 delegate 協管功能。');
  }
  actor = await command.guild.members.fetch({ user: command.user.id, force: true });
  channel = await command.guild.channels.fetch(channelId, { force: true });
  const bot = await command.guild.members.fetchMe({ force: true });
  if (!administrator(actor)) throw new UserError('你的管理員權限已變更，未指派建立者。');
  if (!isSubareaThread(channel) || channel.guildId !== command.guildId) throw new UserError('討論串已不存在。');
  botPermissions(bot, channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageThreads]);
  if (!channel.permissionsFor(owner)?.has(PermissionFlagsBits.ViewChannel)) throw new UserError('指定的建立者無法查看這個討論串。');
  store.setSubarea(command.guildId, channel.id, owner.id);
  store.deleteSubareaRestriction(command.guildId, channel.id, owner.id);
  const suffix = await record(command, store, 'subarea-assign', owner.id, '指派討論串建立者', `討論串 ${channel.id}`);
  await command.editReply({ content: `已登記 <#${channel.id}> 的建立者為 <@${owner.id}>。${suffix}`, allowedMentions: noMentions });
}

export async function handleThreadSubarea(command: Command, store: Store): Promise<boolean> {
  const action = command.options.getSubcommand();
  if (action === 'assign') {
    const selected = command.options.getChannel('channel', true);
    const channel = await command.guild.channels.fetch(selected.id, { force: true });
    if (!isSubareaThread(channel)) return false;
    await managedAreaOperation(`${command.guildId}:${channel.id}`, () => assign(command, store, channel.id));
    return true;
  }
  const channel = await command.guild.channels.fetch(command.channelId, { force: true });
  if (!isSubareaThread(channel) || !['mute', 'unmute', 'kick', 'unkick', 'tag', 'role-tag', 'announce'].includes(action)) return false;
  await managedAreaOperation(`${command.guildId}:${channel.id}`, async () => {
    if (action === 'mute' || action === 'unmute' || action === 'kick' || action === 'unkick') {
      await moderate(command, store, action);
    } else await tag(command, store, action as 'tag' | 'role-tag' | 'announce');
  });
  return true;
}

function validParent(parent: GuildBasedChannel | null, type: string, settings: ReturnType<Store['getSettings']>): boolean {
  if (!parent || (type === 'thread' ? parent.type !== ChannelType.GuildText : parent.type !== ChannelType.GuildForum)) return false;
  return (type === 'forum' && settings.subareaForumId === parent.id)
    || (settings.subareaCategoryId !== null && parent.parentId === settings.subareaCategoryId);
}

/** User-created through the Bot, with the user's ownership saved independently of Discord's bot owner field. */
export async function createThreadSubarea(command: Command, store: Store): Promise<void> {
  await managedAreaOperation(`${command.guildId}:create:${command.user.id}`, async () => {
    const type = command.options.getString('type') ?? 'thread';
    if (type !== 'thread' && type !== 'forum') throw new UserError('請選擇討論串或論壇帖子。');
    const name = command.options.getString('name', true).trim();
    if (!name || name.length > 80) throw new UserError('子區名稱須為 1 至 80 個字。');
    const content = command.options.getString('content')?.trim() || '這是新建立的子區，可使用 /subarea 查看管理功能。';
    if (content.length > 2000) throw new UserError('開帖內容最多 2000 個字。');
    let settings = store.getSettings(command.guildId);
    const selected = command.options.getChannel('parent');
    const parentId = selected?.id ?? (type === 'forum' ? settings.subareaForumId : command.channelId);
    if (!parentId) throw new UserError('請選擇父頻道，或請管理員設定可用的論壇。');
    await command.guild.roles.fetch();
    let [actor, bot, parent] = await Promise.all([
      command.guild.members.fetch({ user: command.user.id, force: true }),
      command.guild.members.fetchMe({ force: true }),
      command.guild.channels.fetch(parentId, { force: true }),
    ]);
    if (!validParent(parent, type, settings) || parent?.guildId !== command.guildId) {
      throw new UserError('這個父頻道尚未開放建立子區；請選擇管理員設定的分類內頻道或指定論壇。');
    }
    let count = 0;
    for (const area of store.listSubareas(command.guildId, command.user.id)) {
      try {
        const found = await command.guild.channels.fetch(area.channelId, { force: true });
        if (!found) store.deleteSubarea(command.guildId, area.channelId);
        else count += 1;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10003) store.deleteSubarea(command.guildId, area.channelId);
        else throw error;
      }
    }
    if (count >= 3) throw new UserError('每位用戶最多透過機器人保留 3 個子區，請先刪除不再使用的子區。');
    // Validate configuration and memberships again after pruning awaited REST calls.
    settings = store.getSettings(command.guildId);
    [actor, bot, parent] = await Promise.all([
      command.guild.members.fetch({ user: command.user.id, force: true }),
      command.guild.members.fetchMe({ force: true }),
      command.guild.channels.fetch(parentId, { force: true }),
    ]);
    if (!validParent(parent, type, settings) || !parent || parent.guildId !== command.guildId) {
      throw new UserError('子區設定已變更，未建立討論串。');
    }
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages,
      ...(type === 'thread' ? [PermissionFlagsBits.CreatePublicThreads] : [])];
    if (!parent.permissionsFor(actor)?.has(required)) throw new UserError('你缺少查看、發文或建立討論串的權限。');
    botPermissions(bot, parent, [...required, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ManageThreads]);
    const reason = truncate(`由用戶 ${actor.id} 建立子區`, 512);
    let created: ThreadChannel;
    if (parent.type === ChannelType.GuildForum) {
      created = await parent.threads.create({ name, message: { content, allowedMentions: noMentions }, reason });
    } else if (parent.type === ChannelType.GuildText) {
      created = await parent.threads.create({ name, type: ChannelType.PublicThread, reason });
    } else throw new UserError('不支援此父頻道。');
    try { store.setSubarea(command.guildId, created.id, actor.id); }
    catch (error) {
      try { await created.delete('建立者資料儲存失敗，回復建立操作'); }
      catch (rollbackError) { logFailure('子區資料儲存失敗且回復刪除失敗', rollbackError); }
      throw error;
    }
    let warning = '';
    try {
      if (parent.type === ChannelType.GuildText) await created.send({ content, allowedMentions: noMentions });
      await created.members.add(actor.id);
    } catch (error) {
      logFailure('子區已建立，但開帖訊息或加入建立者失敗', error);
      warning = '\n⚠️ 子區已保存，但開帖訊息或加入成員失敗，請開啟子區後手動加入。';
    }
    const suffix = await record(command, store, 'subarea-create', actor.id, '建立討論串子區', `子區 ${created.id}；父頻道 ${parent.id}`);
    await command.editReply({ content: `已建立${type === 'forum' ? '論壇帖子' : '討論串'} <#${created.id}>。${warning}${suffix}`,
      allowedMentions: noMentions });
  });
}

type ReactiveRestriction = { member: GuildMember; muted: boolean; locked: boolean };

async function restrictedMember(channel: ThreadChannel, userId: string, store: Store): Promise<ReactiveRestriction | null> {
  const area = store.getSubarea(channel.guildId, channel.id);
  const restriction = store.getSubareaRestriction(channel.guildId, channel.id, userId);
  const locked = store.getSubareaLock(channel.guildId, channel.id) !== null;
  if (!area || area.ownerId === userId || (!restriction?.muted && !locked)) return null;
  let member: GuildMember;
  try {
    // GuildMember.permissions reads role objects from the guild cache. Refresh both
    // records before deciding whether a now-promoted moderator is exempt.
    await channel.guild.roles.fetch();
    member = await channel.guild.members.fetch({ user: userId, force: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 10007) return null;
    throw error;
  }
  if (member.user.bot || member.id === channel.guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)
    || member.permissions.has(PermissionFlagsBits.ManageGuild)) return null;
  const current = store.getSubarea(channel.guildId, channel.id);
  const muted = store.getSubareaRestriction(channel.guildId, channel.id, userId)?.muted === true;
  const stillLocked = store.getSubareaLock(channel.guildId, channel.id) !== null;
  if (!current || current.ownerId === userId || (!muted && !stillLocked)) return null;
  return { member, muted, locked: stillLocked };
}

export async function handleSubareaThreadMessage(message: Message, store: Store): Promise<void> {
  if (message.author.bot || !message.guild || !isSubareaThread(message.channel)) return;
  try {
    const restriction = await restrictedMember(message.channel, message.author.id, store);
    if (!restriction) return;
    const { member } = restriction;
    await message.delete();
    const key = `${message.guild.id}:${message.channel.id}:${member.id}`;
    const now = Date.now();
    if (now - (lastNotice.get(key) ?? 0) >= 60_000) {
      lastNotice.set(key, now);
      if (lastNotice.size > 2000) for (const [saved, time] of lastNotice) if (now - time >= 60_000) lastNotice.delete(saved);
      const explanation = restriction.muted
        ? `你目前在子區 <#${message.channel.id}> 被禁言，新訊息已刪除。其他頻道不受影響；可使用 /appeal 提交處罰申訴。`
        : `子區 <#${message.channel.id}> 已鎖定，只有建立者與管理員可發言；你的新訊息已刪除。其他頻道不受影響。`;
      try { await member.send({ content: explanation, allowedMentions: noMentions }); }
      catch (error) { logFailure('討論串禁言提示私訊失敗', error); }
    }
  } catch (error) { logFailure('討論串禁言訊息處理失敗', error); }
}

export async function handleSubareaThreadReaction(
  reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, store: Store,
): Promise<void> {
  if (user.bot || !reaction.message.guild || !isSubareaThread(reaction.message.channel)) return;
  try {
    if (!await restrictedMember(reaction.message.channel, user.id, store)) return;
    await reaction.users.remove(user.id);
  } catch (error) { logFailure('討論串禁言反應處理失敗', error); }
}
