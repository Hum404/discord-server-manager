import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { MANAGEMENT_SCOPES, SCOPE_LABELS, scopeForCommand } from './domain.js';

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
  access: PermissionFlagsBits.Administrator,
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
  // Moderation permissions are checked against native permissions or a stored
  // grant at execution time. Discord must allow delegated members to see them.
  if (scopeForCommand(name) !== null) builder.setDefaultMemberPermissions(null);
  else if (permission !== null) builder.setDefaultMemberPermissions(permission);
  return builder;
}

const scopeChoices = [
  { name: '全部管理功能', value: 'all' },
  ...MANAGEMENT_SCOPES.map((scope) => ({ name: SCOPE_LABELS[scope], value: scope })),
];

const appealStatusChoices = [
  { name: '待審核', value: 'open' },
  { name: '已通過', value: 'accepted' },
  { name: '已駁回', value: 'rejected' },
];

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
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('appeals').setDescription('設定私密申訴審核頻道；不選頻道則停用通知')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('僅管理人員可見的申訴審核文字頻道')
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('subareas').setDescription('開放在指定分類建立子區；不選分類則停用建立')
        .addChannelOption((option) =>
          option.setName('category').setDescription('用戶可建立獨立文字子區的分類')
            .addChannelTypes(ChannelType.GuildCategory),
        ),
    ),
  command('access', '管理用戶透過機器人執行管理操作的授權')
    .addSubcommand((subcommand) =>
      subcommand.setName('grant').setDescription('授予用戶指定的機器人管理功能')
        .addUserOption((option) =>
          option.setName('user').setDescription('要授權的成員').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('scope').setDescription('允許使用的管理功能')
            .setRequired(true).addChoices(...scopeChoices),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('revoke').setDescription('撤回用戶指定或全部的機器人管理授權')
        .addUserOption((option) =>
          option.setName('user').setDescription('要撤回授權的成員').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('scope').setDescription('要撤回的功能；留空則撤回全部')
            .addChoices(...scopeChoices),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('查看本伺服器的機器人管理授權')
        .addUserOption((option) =>
          option.setName('user').setDescription('只查看此成員；留空則查看全部'),
        ),
    ),
  command('appeal', '提交處罰申訴、查看工單或審核申訴')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .addSubcommand((subcommand) =>
      subcommand.setName('submit').setDescription('開啟表單，對自己的處罰案件提出申訴')
        .addIntegerOption((option) =>
          option.setName('case').setDescription('處罰案件編號；留空使用最近的處罰')
            .setMinValue(1),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription('查看自己的申訴工單與處理結果')
        .addIntegerOption((option) =>
          option.setName('id').setDescription('工單編號；留空查看最近的工單')
            .setMinValue(1),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('queue').setDescription('管理員查看本伺服器的申訴工單')
        .addIntegerOption((option) =>
          option.setName('id').setDescription('查看指定工單的完整內容；留空列出工單')
            .setMinValue(1),
        )
        .addStringOption((option) =>
          option.setName('status').setDescription('依處理狀態篩選；預設待審核')
            .addChoices(...appealStatusChoices),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('review').setDescription('管理員審核申訴工單並提供處理說明')
        .addIntegerOption((option) =>
          option.setName('id').setDescription('申訴工單編號').setMinValue(1).setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('result').setDescription('審核結果').setRequired(true)
            .addChoices(
              { name: '通過申訴', value: 'accepted' },
              { name: '駁回申訴', value: 'rejected' },
            ),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('提供給申訴人的處理說明')
            .setMinLength(1).setMaxLength(1000).setRequired(true),
        ),
    ),
  command('subarea', '建立自己的文字子區，並管理該子區內的成員權限')
    .addSubcommand((subcommand) =>
      subcommand.setName('create').setDescription('在管理員開放的分類中建立自己的文字子區')
        .addStringOption((option) =>
          option.setName('name').setDescription('子區名稱').setMinLength(1).setMaxLength(80).setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('assign').setDescription('管理員指定既有文字子區的建立者')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('要指定建立者的文字頻道')
            .addChannelTypes(ChannelType.GuildText).setRequired(true),
        )
        .addUserOption((option) =>
          option.setName('user').setDescription('此子區的建立者').setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('查看自己在本伺服器建立的子區'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('mute').setDescription('禁止成員在目前子區發言，不影響其他頻道')
        .addUserOption((option) =>
          option.setName('user').setDescription('要在此子區禁言的成員').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('子區禁言原因').setMaxLength(512).setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('unmute').setDescription('解除成員在目前子區的禁言')
        .addUserOption((option) =>
          option.setName('user').setDescription('要解除子區禁言的成員').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('解除子區禁言的原因').setMaxLength(512),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('kick').setDescription('禁止成員查看及進入目前子區，不踢出伺服器')
        .addUserOption((option) =>
          option.setName('user').setDescription('要移除此子區存取權的成員').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('移除子區存取權的原因').setMaxLength(512).setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('unkick').setDescription('恢復成員進入目前子區的權限')
        .addUserOption((option) =>
          option.setName('user').setDescription('要恢復子區存取權的成員').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('恢復子區存取權的原因').setMaxLength(512),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('tag').setDescription('僅子區建立者可透過機器人標註指定用戶')
        .addUserOption((option) =>
          option.setName('user').setDescription('要標註的用戶').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('message').setDescription('附加訊息').setMaxLength(500),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('role-tag').setDescription('僅子區建立者可透過機器人標註指定身分組')
        .addRoleOption((option) =>
          option.setName('role').setDescription('要標註的身分組').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('message').setDescription('附加訊息').setMaxLength(500),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('announce').setDescription('僅子區建立者可在目前子區標註 everyone 或 here')
        .addStringOption((option) =>
          option.setName('audience').setDescription('要通知的子區成員').setRequired(true)
            .addChoices(
              { name: 'everyone', value: 'everyone' },
              { name: 'here', value: 'here' },
            ),
        )
        .addStringOption((option) =>
          option.setName('message').setDescription('公告內容').setMaxLength(500).setRequired(true),
        ),
    ),
];
