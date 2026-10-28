import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType,
  MessageFlags, PermissionFlagsBits,
  type GuildBasedChannel, type GuildMember, type Message, type MessageContextMenuCommandInteraction,
  type NewsChannel, type PrivateThreadChannel, type PublicThreadChannel, type TextChannel,
} from 'discord.js';
import { record } from './audit.js';
import { MESSAGE_APP_DELETE_NAME, MESSAGE_APP_PIN_NAME } from './commands.js';
import { UserError } from './errors.js';
import { requireBotPermissions, requirePrivateThreadAccess } from './permissions.js';
import { Store } from './store.js';
import { ensureThreadArea } from './subarea-threads.js';
import { managedAreaOperation, mutateSubareaMessage } from './subarea-tools.js';

type Command = MessageContextMenuCommandInteraction<'cached'>;
type MessageChannel = TextChannel | NewsChannel | PublicThreadChannel | PrivateThreadChannel;
type NativeContext = { actor: GuildMember; bot: GuildMember; channel: MessageChannel };
const noMentions = { parse: [] as never[] };

function supportsMessages(channel: GuildBasedChannel | null): channel is MessageChannel {
  return channel !== null && [ChannelType.GuildText, ChannelType.GuildAnnouncement,
    ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channel.type);
}

function assertNativeAuthority(command: Command, store: Store, current: NativeContext, permission: bigint): void {
  if (store.getSubarea(command.guildId, current.channel.id)) {
    throw new UserError('這個頻道已登記為子區，請重新選擇 APP 操作以套用子區管理權限。');
  }
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, permission];
  if (!current.channel.permissionsFor(current.actor)?.has(required)) {
    throw new UserError(permission === PermissionFlagsBits.PinMessages
      ? '你需要此頻道的查看、讀取歷史及置頂訊息權限。'
      : '你需要此頻道的查看、讀取歷史及管理訊息權限。');
  }
  const botError = requireBotPermissions(current.bot, current.channel, required);
  if (botError) throw new UserError(botError);
}

async function nativeContext(command: Command, store: Store, permission: bigint): Promise<NativeContext> {
  await command.guild.roles.fetch();
  const [actor, bot, channel] = await Promise.all([
    command.guild.members.fetch({ user: command.user.id, force: true }),
    command.guild.members.fetchMe({ force: true }),
    command.guild.channels.fetch(command.channelId, { force: true }),
  ]);
  if (!supportsMessages(channel) || channel.guildId !== command.guildId) {
    throw new UserError('請選擇目前伺服器文字頻道或討論串內的訊息。');
  }
  const current = { actor, bot, channel };
  assertNativeAuthority(command, store, current, permission);
  const privateAccess = await requirePrivateThreadAccess(channel, actor);
  if (privateAccess) throw new UserError(privateAccess);
  assertNativeAuthority(command, store, current, permission);
  return current;
}

async function selectedMessage(command: Command, channel: MessageChannel): Promise<Message> {
  let message: Message;
  try { message = await channel.messages.fetch({ message: command.targetId, force: true, cache: false }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 10008) {
      throw new UserError('這則訊息已被刪除，請重新選擇訊息。');
    }
    throw error;
  }
  if (message.id !== command.targetId || message.channelId !== command.channelId || message.guildId !== command.guildId) {
    throw new UserError('只能操作你在目前伺服器及頻道選中的訊息。');
  }
  return message;
}

async function confirmDeletion(command: Command): Promise<boolean> {
  const yes = `message-app:${command.id}:delete`;
  const no = `message-app:${command.id}:cancel`;
  const link = `https://discord.com/channels/${command.guildId}/${command.channelId}/${command.targetId}`;
  const reply = await command.editReply({
    content: `確定刪除[這則訊息](${link})？刪除後無法還原。\n請在 30 秒內確認。`,
    allowedMentions: noMentions,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(yes).setLabel('確認刪除').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(no).setLabel('取消').setStyle(ButtonStyle.Secondary),
    )],
  });
  let button;
  try {
    button = await reply.awaitMessageComponent({ componentType: ComponentType.Button, time: 30_000,
      filter: (interaction) => interaction.user.id === command.user.id && [yes, no].includes(interaction.customId) });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'InteractionCollectorError') {
      await command.editReply({ content: '確認已逾時，未刪除訊息。', components: [] });
      return false;
    }
    throw error;
  }
  const accepted = button.customId === yes;
  await button.update({ content: accepted ? '正在核對權限…' : '已取消操作。', components: [] });
  return accepted;
}

async function mutateNativeMessage(command: Command, store: Store, deleting: boolean): Promise<void> {
  const permission = deleting ? PermissionFlagsBits.ManageMessages : PermissionFlagsBits.PinMessages;
  let current = await nativeContext(command, store, permission);
  await selectedMessage(command, current.channel);
  if (deleting && !await confirmDeletion(command)) return;
  current = await nativeContext(command, store, permission);
  const message = await selectedMessage(command, current.channel);
  // A message fetch can outlive a role or channel overwrite change; fetch authority again.
  current = await nativeContext(command, store, permission);
  assertNativeAuthority(command, store, current, permission);
  const action = deleting ? 'delete' : message.pinned ? 'unpin' : 'pin';
  if (action === 'delete') await message.delete();
  else if (action === 'unpin') await message.unpin(`管理者 ${command.user.id} 取消置頂`);
  else await message.pin(`管理者 ${command.user.id} 置頂`);
  const description = action === 'delete' ? '已刪除選中的訊息。'
    : action === 'unpin' ? '已取消標註（置頂）。' : '已標註（置頂）選中的訊息。';
  const suffix = await record(command, store, `message-${action}`, null, description,
    `頻道 ${current.channel.id}；訊息 ${command.targetId}`);
  await command.editReply({ content: description + suffix, components: [], allowedMentions: noMentions });
}

/** Message APP entries use the selected message directly and share subarea authorization. */
export async function handleMessageAppCommand(command: MessageContextMenuCommandInteraction, store: Store): Promise<void> {
  if (!command.inCachedGuild()) {
    await command.reply({ content: '請在機器人所在的伺服器內，選擇訊息的 APP 選單操作。', flags: MessageFlags.Ephemeral });
    return;
  }
  await command.deferReply({ flags: MessageFlags.Ephemeral });
  if (command.commandName !== MESSAGE_APP_PIN_NAME && command.commandName !== MESSAGE_APP_DELETE_NAME) {
    throw new UserError('此 APP 指令已停用，請重新開啟選單並選擇最新指令。');
  }
  const target = command.targetMessage;
  if (target.id !== command.targetId || target.guildId !== command.guildId || target.channelId !== command.channelId) {
    throw new UserError('只能操作你在目前伺服器及頻道選中的訊息。');
  }
  await managedAreaOperation(`${command.guildId}:${command.channelId}`, async () => {
    await ensureThreadArea(command, store);
    if (store.getSubarea(command.guildId, command.channelId)) {
      await mutateSubareaMessage(command, store,
        command.commandName === MESSAGE_APP_DELETE_NAME ? 'delete-message' : 'toggle-pin', command.targetId);
    } else await mutateNativeMessage(command, store, command.commandName === MESSAGE_APP_DELETE_NAME);
  });
}
