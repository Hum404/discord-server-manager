import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

const commandPermissions: Record<string, bigint> = {
  warn: PermissionFlagsBits.ModerateMembers,
  warnings: PermissionFlagsBits.ModerateMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
  untimeout: PermissionFlagsBits.ModerateMembers,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
  unban: PermissionFlagsBits.BanMembers,
  clear: PermissionFlagsBits.ManageMessages,
  config: PermissionFlagsBits.ManageGuild,
};

export function permissionForCommand(commandName: string): bigint | null {
  return Object.hasOwn(commandPermissions, commandName) ? commandPermissions[commandName] ?? null : null;
}

function command(name: string, description: string): SlashCommandBuilder {
  const builder = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild);
  const permission = permissionForCommand(name);
  if (permission !== null) builder.setDefaultMemberPermissions(permission);
  return builder;
}

export const commands = [
  command('help', '查看機器人的管理指令與使用方式'),
  command('ping', '查看機器人連線狀態與延遲'),
  command('warn', '新增一筆成員警告，並永久保存紀錄')
    .addUserOption((option) =>
      option.setName('user').setDescription('要警告的成員').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('警告原因').setMaxLength(512).setRequired(true),
    ),
  command('warnings', '查看成員的警告紀錄')
    .addUserOption((option) =>
      option.setName('user').setDescription('要查看的成員').setRequired(true),
    ),
  command('timeout', '將成員禁言，最長 28 天')
    .addUserOption((option) =>
      option.setName('user').setDescription('要禁言的成員').setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName('minutes').setDescription('禁言分鐘數（1 至 40320）')
        .setMinValue(1).setMaxValue(40_320).setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('禁言原因').setMaxLength(512).setRequired(true),
    ),
  command('untimeout', '解除成員的禁言')
    .addUserOption((option) =>
      option.setName('user').setDescription('要解除禁言的成員').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('解除原因').setMaxLength(512).setRequired(true),
    ),
  command('kick', '確認後將成員踢出伺服器')
    .addUserOption((option) =>
      option.setName('user').setDescription('要踢出的成員').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('踢出原因').setMaxLength(512).setRequired(true),
    ),
  command('ban', '確認後封鎖成員，可選擇刪除近期訊息')
    .addUserOption((option) =>
      option.setName('user').setDescription('要封鎖的成員').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('封鎖原因').setMaxLength(512).setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName('delete_days').setDescription('同時刪除近幾天的訊息（預設 0 天）')
        .setMinValue(0).setMaxValue(7),
    ),
  command('unban', '透過使用者 ID 解除封鎖')
    .addStringOption((option) =>
      option.setName('user_id').setDescription('已封鎖使用者的 Discord ID（17 至 20 位數字）')
        .setMinLength(17).setMaxLength(20).setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('解除封鎖原因').setMaxLength(512).setRequired(true),
    ),
  command('clear', '確認後清理目前頻道最近的訊息（最多 100 則）')
    .addIntegerOption((option) =>
      option.setName('amount').setDescription('刪除數量（僅能刪除 14 天內的訊息）')
        .setMinValue(1).setMaxValue(100).setRequired(true),
    ),
  command('config', '設定本伺服器的管理紀錄與歡迎訊息')
    .addSubcommand((subcommand) =>
      subcommand.setName('view').setDescription('查看目前的伺服器設定'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('logs').setDescription('設定管理紀錄頻道；不選頻道則停用')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('管理紀錄發送至此頻道')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('welcome').setDescription('設定歡迎頻道；不選頻道則停用')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('新成員歡迎訊息發送至此頻道')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('welcome-message').setDescription('設定歡迎內容，可用 {user}、{server}、{count}')
        .addStringOption((option) =>
          option.setName('message').setDescription('歡迎內容（最長 1000 字）')
            .setMinLength(1).setMaxLength(1000).setRequired(true),
        ),
    ),
];
