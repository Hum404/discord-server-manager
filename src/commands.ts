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
  admin: PermissionFlagsBits.ManageGuild,
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
      subcommand.setName('logs').setDescription('設定本服日誌通知頻道；省略停用通知，本機案件仍保留')
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
      subcommand.setName('subareas').setDescription('設定子區分類及論壇；兩者都不選則停用建立')
        .addChannelOption((option) =>
          option.setName('category').setDescription('允許建立文字子區及討論串的分類')
            .addChannelTypes(ChannelType.GuildCategory),
        )
        .addChannelOption((option) =>
          option.setName('forum').setDescription('允許建立論壇帖子的論壇頻道')
            .addChannelTypes(ChannelType.GuildForum),
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
          option.setName('case').setDescription('該伺服器的處罰案件編號；留空使用最近的處罰')
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
  command('subarea', '管理自己的文字子區、討論串及論壇帖子')
    .addSubcommand((subcommand) =>
      subcommand.setName('create').setDescription('在開放的分類或論壇建立文字子區、討論串或帖子')
        .addStringOption((option) =>
          option.setName('name').setDescription('子區名稱').setMinLength(1).setMaxLength(80).setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('type').setDescription('子區類型；預設獨立文字頻道')
            .addChoices(
              { name: '獨立文字頻道', value: 'text' },
              { name: '討論串', value: 'thread' },
              { name: '論壇帖子', value: 'forum' },
            ),
        )
        .addChannelOption((option) =>
          option.setName('parent').setDescription('討論串的文字頻道或帖子的論壇；須在開放範圍內')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum),
        )
        .addStringOption((option) =>
          option.setName('content').setDescription('論壇帖子首則內容；留空使用預設文字')
            .setMinLength(1).setMaxLength(2000),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('assign').setDescription('管理員登記既有子區；原生用戶建立的討論串保留原帖主')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('要登記的文字頻道、討論串或論壇帖子')
            .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread)
            .setRequired(true),
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
      subcommand.setName('kick').setDescription('文字子區禁止存取；討論串僅移除成員，不踢出伺服器')
        .addUserOption((option) =>
          option.setName('user').setDescription('要移除此子區存取權的成員').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('移除子區存取權的原因').setMaxLength(512).setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('unkick').setDescription('恢復文字子區存取或將成員重新加入討論串')
        .addUserOption((option) =>
          option.setName('user').setDescription('要恢復子區存取權的成員').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('恢復子區存取權的原因').setMaxLength(512),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('tag').setDescription('僅目前子區建立者可透過機器人提及指定用戶')
        .addUserOption((option) =>
          option.setName('user').setDescription('要提及的用戶').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('message').setDescription('附加訊息').setMaxLength(500),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('role-tag').setDescription('僅目前子區建立者可透過機器人提及指定身分組')
        .addRoleOption((option) =>
          option.setName('role').setDescription('要提及的身分組').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('message').setDescription('附加訊息').setMaxLength(500),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('announce').setDescription('僅目前子區建立者可在子區提及 everyone 或 here')
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
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('pin').setDescription('僅目前建立者可標註（置頂）子區內訊息')
        .addStringOption((option) => option.setName('message').setDescription('目前子區的訊息連結或訊息 ID')
          .setMinLength(17).setMaxLength(200).setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('unpin').setDescription('僅目前建立者可取消標註（置頂）子區內訊息')
        .addStringOption((option) => option.setName('message').setDescription('目前子區的訊息連結或訊息 ID')
          .setMinLength(17).setMaxLength(200).setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('delete-message').setDescription('刪除目前子區中的指定訊息')
        .addStringOption((option) => option.setName('message').setDescription('目前子區的訊息連結或訊息 ID')
          .setMinLength(17).setMaxLength(200).setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('slowmode').setDescription('設定目前子區的慢速模式；0 表示關閉')
        .addIntegerOption((option) => option.setName('seconds').setDescription('每次發言間隔秒數（0 至 21600）')
          .setMinValue(0).setMaxValue(21600).setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('rename').setDescription('修改目前子區名稱')
        .addStringOption((option) => option.setName('name').setDescription('新的子區名稱')
          .setMinLength(1).setMaxLength(80).setRequired(true)),
    )
    .addSubcommand((subcommand) => subcommand.setName('lock').setDescription('鎖定子區；討論串會一併封存'))
    .addSubcommand((subcommand) => subcommand.setName('unlock').setDescription('解鎖子區；討論串會解除封存'))
    .addSubcommand((subcommand) => subcommand.setName('delete').setDescription('僅目前建立者可刪除自己的子區，須兩次確認'))
    .addSubcommand((subcommand) =>
      subcommand.setName('delegate').setDescription('建立者或管理員授予成員目前子區的協管權限')
        .addUserOption((option) => option.setName('user').setDescription('要授權為本子區協管的成員').setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('undelegate').setDescription('建立者或管理員撤回目前子區的協管權限')
        .addUserOption((option) => option.setName('user').setDescription('要撤回本子區協管權限的成員').setRequired(true)),
    )
    .addSubcommand((subcommand) => subcommand.setName('delegates').setDescription('查看目前子區的協管名單'))
    .addSubcommand((subcommand) => subcommand.setName('info').setDescription('查看目前子區的建立者、協管與限制狀態')),
  command('admin', '查看管理案件、移除警告及管理身分組和頻道')
    .addSubcommand((subcommand) =>
      subcommand.setName('cases').setDescription('查看本伺服器最近 10 筆管理案件')
        .addUserOption((option) => option.setName('user').setDescription('只查看此用戶的案件')),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('case').setDescription('查看本伺服器指定管理案件的完整紀錄')
        .addIntegerOption((option) => option.setName('id').setDescription('本伺服器獨立的管理案件編號').setMinValue(1).setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('warning-remove').setDescription('確認後移除一筆警告，保留原案件並記錄移除原因')
        .addIntegerOption((option) => option.setName('id').setDescription('警告編號，與管理案件編號不同')
          .setMinValue(1).setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('移除警告的原因')
          .setMinLength(1).setMaxLength(512).setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('role-add').setDescription('新增成員身分組；另需原生管理身分組權限')
        .addUserOption((option) => option.setName('user').setDescription('要新增身分組的成員').setRequired(true))
        .addRoleOption((option) => option.setName('role').setDescription('要新增的身分組').setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('新增身分組的原因')
          .setMinLength(1).setMaxLength(512).setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('role-remove').setDescription('移除成員身分組；另需原生管理身分組權限')
        .addUserOption((option) => option.setName('user').setDescription('要移除身分組的成員').setRequired(true))
        .addRoleOption((option) => option.setName('role').setDescription('要移除的身分組').setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('移除身分組的原因')
          .setMinLength(1).setMaxLength(512).setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('channel-edit').setDescription('編輯文字或公告頻道；另需原生管理頻道權限')
        .addChannelOption((option) => option.setName('channel').setDescription('要編輯的頻道')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('編輯頻道的原因')
          .setMinLength(1).setMaxLength(512).setRequired(true))
        .addStringOption((option) => option.setName('name').setDescription('新頻道名稱').setMinLength(1).setMaxLength(100))
        .addIntegerOption((option) => option.setName('slowmode').setDescription('慢速模式秒數；0 表示關閉')
          .setMinValue(0).setMaxValue(21600))
        .addBooleanOption((option) => option.setName('nsfw').setDescription('是否標示為年齡限制頻道')),
    ),
];
