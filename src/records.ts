import {
  AttachmentBuilder, EmbedBuilder, PermissionFlagsBits, escapeMarkdown,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { UserError } from './errors.js';
import { truncate } from './presentation.js';
import { Store, type ModerationCase } from './store.js';

type Command = ChatInputCommandInteraction<'cached'>;
type Direction = 'performed' | 'received' | 'all';
const noMentions = { parse: [] as never[] };
const unavailable = '找不到符合此成員及查詢條件的本服成員紀錄。';
const directionNames: Record<Direction, string> = {
  performed: '執行的操作', received: '收到的操作', all: '全部相關操作',
};
const actionNames: Record<string, string> = {
  'subarea-create': '建立子區', 'subarea-assign': '指派子區建立者',
  'subarea-mute': '子區禁言', 'subarea-unmute': '解除子區禁言',
  'subarea-kick': '子區移除', 'subarea-unkick': '恢復子區存取',
  'subarea-pin': '子區訊息置頂', 'subarea-unpin': '取消子區置頂',
  'subarea-delete-message': '刪除子區訊息', 'subarea-slowmode': '調整子區慢速模式',
  'subarea-rename': '修改子區名稱', 'subarea-lock': '鎖定子區', 'subarea-unlock': '解鎖子區',
  'subarea-delete': '刪除子區', 'subarea-delegate': '授予子區協管', 'subarea-undelegate': '撤回子區協管',
  'subarea-tag': '子區提及通知', 'subarea-role-tag': '子區身分組通知', 'subarea-announce': '子區全體通知',
  'message-pin': '置頂訊息', 'message-unpin': '取消置頂訊息', 'message-delete': '刪除訊息',
  clear: '清理訊息', config: '更新設定', 'role-add': '新增身分組', 'role-remove': '移除身分組',
  'channel-edit': '編輯頻道', 'access-grant': '管理功能授權', 'access-revoke': '撤回管理功能授權',
  'appeal-submit': '提交申訴', 'appeal-review': '審核申訴',
};

function direction(value: string | null): Direction {
  if (value === null) return 'performed';
  if (value !== 'performed' && value !== 'received' && value !== 'all') {
    throw new UserError('請選擇執行的操作、收到的操作或全部相關操作。');
  }
  return value;
}

async function authorize(command: Command, memberId: string): Promise<void> {
  await command.guild.roles.fetch();
  const actor = await command.guild.members.fetch({ user: command.user.id, force: true });
  if (memberId !== actor.id && actor.id !== command.guild.ownerId
    && !actor.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('你只能查看自己的成員紀錄；查詢其他成員需要原生管理伺服器權限。');
  }
}

function actionLabel(action: string): string {
  return escapeMarkdown(actionNames[action] ?? action);
}

function timeLabel(createdAt: string): string {
  const milliseconds = Date.parse(createdAt);
  return Number.isFinite(milliseconds) ? `<t:${Math.floor(milliseconds / 1000)}:f>` : '時間未提供';
}

function targetLabel(item: ModerationCase): string {
  return item.userId ? `<@${item.userId}>（${item.userId}）` : item.channelId ? `<#${item.channelId}>` : '頻道或伺服器設定';
}

function fullRecord(item: ModerationCase): string {
  return [`成員操作紀錄 #${item.caseNumber}`, `伺服器：${item.guildId}`,
    `操作：${actionNames[item.action] ?? item.action}`, `執行者：${item.moderatorId}`,
    `操作對象：${item.userId ?? '無指定成員'}`, `頻道：${item.channelId ?? '未記錄'}`,
    `時間：${item.createdAt}`, '', '原因：', item.reason,
    ...(item.details ? ['', '詳細內容：', item.details] : [])].join('\n');
}

/** Called after an ephemeral defer; each lookup stays within this guild and the chosen member. */
export async function handleRecordsCommand(command: Command, store: Store): Promise<void> {
  const memberId = command.options.getUser('user')?.id ?? command.user.id;
  const selectedDirection = direction(command.options.getString('direction'));
  const id = command.options.getInteger('id');
  if (id !== null && (!Number.isSafeInteger(id) || id < 1)) throw new UserError('請輸入有效的本服成員紀錄編號。');
  // A selected user can have left the guild. Authorization depends on the current
  // reader's real roles, not on whether historical participants are still members.
  await authorize(command, memberId);
  if (id !== null) {
    const item = store.getMemberCase(command.guildId, id, memberId, selectedDirection);
    if (!item) throw new UserError(unavailable);
    const reason = escapeMarkdown(item.reason);
    const details = item.details === null ? null : escapeMarkdown(item.details);
    const needsAttachment = reason.length > 1024 || (details?.length ?? 0) > 1024;
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`成員操作紀錄 #${item.caseNumber}`)
      .addFields(
        { name: '操作', value: truncate(actionLabel(item.action), 100) },
        { name: '執行者', value: `<@${item.moderatorId}>（${item.moderatorId}）` },
        { name: '對象', value: targetLabel(item) },
        { name: '頻道', value: item.channelId ? `<#${item.channelId}>` : '未記錄' },
        { name: '時間', value: timeLabel(item.createdAt) },
        { name: '原因', value: truncate(reason, 1024) },
      );
    if (details) embed.addFields({ name: '詳細內容', value: truncate(details, 1024) });
    if (needsAttachment) embed.setFooter({ text: '文字較長，完整內容見私人附件。' });
    await command.editReply({ embeds: [embed], allowedMentions: noMentions,
      files: needsAttachment ? [new AttachmentBuilder(Buffer.from(fullRecord(item), 'utf8'), {
        name: `member-record-${item.caseNumber}.txt`,
      })] : [] });
    return;
  }
  const entries = store.listMemberCases(command.guildId, memberId, selectedDirection, 10);
  const lines = entries.map((item) => {
    const location = item.channelId ? ` · <#${item.channelId}>` : '';
    const target = item.userId ? ` → <@${item.userId}>` : '';
    return `**紀錄 #${item.caseNumber} · ${truncate(actionLabel(item.action), 60)}**\n`
      + `執行者 <@${item.moderatorId}>${target}${location} · ${timeLabel(item.createdAt)}\n`
      + truncate(escapeMarkdown(item.reason), 180);
  });
  await command.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('成員操作紀錄')
    .setDescription(`<@${memberId}> · ${directionNames[selectedDirection]}\n\n`
      + (lines.length ? truncate(lines.join('\n\n'), 3750) : '沒有符合條件的成員操作紀錄。'))
    .setFooter({ text: '僅顯示本服最近 10 筆；使用 /records id 查看指定紀錄。' })], allowedMentions: noMentions });
}
