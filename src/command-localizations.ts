import {
  ApplicationCommandOptionType, SlashCommandStringOption, SlashCommandSubcommandBuilder, SlashCommandSubcommandGroupBuilder,
  type ContextMenuCommandBuilder, type LocalizationMap, type SlashCommandBuilder,
} from 'discord.js';

type ChineseNames = readonly [traditional: string, simplified: string];

const commandNames: Record<string, ChineseNames> = {
  help: ['說明', '帮助'], ping: ['連線狀態', '连接状态'], records: ['成員紀錄', '成员记录'],
  warn: ['警告', '警告'], warnings: ['警告紀錄', '警告记录'], timeout: ['禁言', '禁言'],
  untimeout: ['解除禁言', '解除禁言'], kick: ['踢出', '踢出'], ban: ['封鎖', '封禁'],
  unban: ['解除封鎖', '解除封禁'], clear: ['清理訊息', '清理消息'], config: ['設定', '设置'],
  access: ['管理授權', '管理授权'], appeal: ['申訴', '申诉'], subarea: ['子區', '子区'],
  admin: ['管理員', '管理员'],
};

const subcommandNames: Record<string, ChineseNames> = {
  'config.view': ['查看', '查看'], 'config.logs': ['管理日誌', '管理日志'],
  'config.punishments': ['處罰通知', '处罚通知'],
  'config.subarea-notices': ['子區通知', '子区通知'],
  'config.punishment-test': ['測試處罰通知', '测试处罚通知'],
  'config.welcome': ['歡迎頻道', '欢迎频道'],
  'config.welcome-message': ['歡迎內容', '欢迎内容'],
  'config.appeals': ['申訴通知', '申诉通知'], 'config.subareas': ['子區範圍', '子区范围'],
  'access.grant': ['授權', '授权'], 'access.revoke': ['撤回', '撤回'],
  'access.list': ['授權清單', '授权列表'],
  'appeal.submit': ['提交', '提交'], 'appeal.status': ['工單狀態', '工单状态'],
  'appeal.queue': ['工單清單', '工单列表'], 'appeal.review': ['審核', '审核'],
  'subarea.create': ['建立', '创建'], 'subarea.assign': ['指定建立者', '指定创建者'],
  'subarea.list': ['我的子區', '我的子区'], 'subarea.mute': ['禁言', '禁言'],
  'subarea.unmute': ['解除禁言', '解除禁言'], 'subarea.kick': ['移除成員', '移除成员'],
  'subarea.unkick': ['恢復成員', '恢复成员'], 'subarea.tag': ['提及用戶', '提及用户'],
  'subarea.role-tag': ['提及身分組', '提及身份组'], 'subarea.announce': ['全體通知', '全体通知'],
  'subarea.pin': ['置頂', '置顶'], 'subarea.unpin': ['取消置頂', '取消置顶'],
  'subarea.delete-message': ['刪除訊息', '删除消息'],
  'subarea.slowmode': ['慢速模式', '慢速模式'], 'subarea.rename': ['改名', '改名'],
  'subarea.lock': ['鎖定', '锁定'], 'subarea.unlock': ['解鎖', '解锁'],
  'subarea.delete': ['刪除子區', '删除子区'],
  'subarea.delegate': ['設定協管', '设置协管'], 'subarea.undelegate': ['撤回協管', '撤回协管'],
  'subarea.delegates': ['協管名單', '协管名单'], 'subarea.info': ['資訊', '信息'],
  'admin.cases': ['處罰清單', '处罚列表'], 'admin.case': ['處罰詳情', '处罚详情'],
  'admin.warning-remove': ['撤銷警告', '撤销警告'],
  'admin.role-add': ['新增身分組', '添加身份组'], 'admin.role-remove': ['移除身分組', '移除身份组'],
  'admin.channel-edit': ['編輯頻道', '编辑频道'],
};

const optionNames: Record<string, ChineseNames> = {
  user: ['成員', '成员'], id: ['編號', '编号'], direction: ['方向', '方向'],
  reason: ['原因', '原因'], minutes: ['分鐘', '分钟'], delete_days: ['刪除天數', '删除天数'],
  user_id: ['用戶編號', '用户编号'], amount: ['數量', '数量'], channel: ['頻道', '频道'],
  'channel-id': ['頻道編號', '频道编号'], enabled: ['啟用', '启用'],
  dm: ['處罰私訊', '处罚私信'], 'include-subareas': ['子區通知', '子区通知'],
  message: ['訊息', '消息'], category: ['分類', '分类'], forum: ['論壇', '论坛'],
  scope: ['功能', '功能'], case: ['案件編號', '案件编号'], status: ['處理狀態', '处理状态'],
  result: ['審核結果', '审核结果'], name: ['名稱', '名称'], type: ['類型', '类型'],
  parent: ['上層頻道', '上级频道'], content: ['內容', '内容'], role: ['身分組', '身份组'],
  audience: ['通知對象', '通知对象'], seconds: ['秒數', '秒数'],
  slowmode: ['慢速秒數', '慢速秒数'], nsfw: ['年齡限制', '年龄限制'],
};

const optionOverrides: Record<string, ChineseNames> = {
  'records.id': ['紀錄編號', '记录编号'],
  'appeal.status.id': ['工單編號', '工单编号'],
  'appeal.queue.id': ['工單編號', '工单编号'],
  'appeal.review.id': ['工單編號', '工单编号'],
  'admin.case.id': ['案件編號', '案件编号'],
  'admin.warning-remove.id': ['警告編號', '警告编号'],
};

const choiceNames: Record<string, ChineseNames> = {
  '執行的操作': ['執行的操作', '执行的操作'], '收到的操作': ['收到的操作', '收到的操作'],
  '全部相關': ['全部相關', '全部相关'], '全部管理功能': ['全部管理功能', '全部管理功能'],
  '警告與警告查詢': ['警告與警告查詢', '警告与警告查询'],
  '禁言與解除禁言': ['禁言與解除禁言', '禁言与解除禁言'],
  '踢出成員': ['踢出成員', '踢出成员'], '封鎖與解除封鎖': ['封鎖與解除封鎖', '封禁与解除封禁'],
  '清理訊息': ['清理訊息', '清理消息'], '待審核': ['待審核', '待审核'],
  '已通過': ['已通過', '已通过'], '已駁回': ['已駁回', '已驳回'],
  '通過申訴': ['通過申訴', '通过申诉'], '駁回申訴': ['駁回申訴', '驳回申诉'],
  '獨立文字頻道': ['獨立文字頻道', '独立文字频道'],
  '討論串': ['討論串', '讨论串'], '論壇帖子': ['論壇帖子', '论坛帖子'],
  everyone: ['全體成員', '全体成员'], here: ['目前在線成員', '当前在线成员'],
};

const messageCommandNames: Record<string, ChineseNames> = {
  '標註／取消標註': ['標註／取消標註', '标注／取消标注'],
  '刪除訊息': ['刪除訊息', '删除消息'],
};

// Discord exposes no hidden search aliases. Distinct Simplified root entries
// use the same canonical subcommand/options and the same execution policy.
const simplifiedRoots = new Map(Object.entries(commandNames)
  .filter(([, names]) => names[0] !== names[1])
  .map(([canonical, names]) => [names[1], canonical]));

export function canonicalCommandName(name: string): string {
  return simplifiedRoots.get(name) ?? name;
}

export function simplifiedCommandName(canonical: string): string | null {
  const names = namesAt(commandNames, canonical);
  return names && names[0] !== names[1] ? names[1] : null;
}

interface NamedBuilder {
  readonly name: string;
  readonly options?: readonly unknown[];
  readonly name_localizations?: LocalizationMap;
  setNameLocalizations(names: LocalizationMap | null): unknown;
}

function namesAt(dictionary: Record<string, ChineseNames>, key: string): ChineseNames | undefined {
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
}

function localization(names: ChineseNames | undefined, path: string): LocalizationMap {
  if (!names) throw new Error(`Missing Chinese command localization: ${path}`);
  // Keep both vocabularies available while presenting consistent Traditional labels.
  return { 'zh-TW': names[0], 'zh-CN': names[0] };
}

type SlashDefinition = ReturnType<SlashCommandBuilder['toJSON']>;
interface DefinitionNode {
  name: string;
  type?: number;
  name_localizations?: LocalizationMap | null;
  options?: DefinitionNode[];
  choices?: Array<{ name: string; name_localizations?: LocalizationMap | null }>;
}

/** Clone a compatibility entry without changing builders, permission bits or choice values. */
export function createSimplifiedCommandDefinition(definition: SlashDefinition): SlashDefinition | null {
  const alias = simplifiedCommandName(definition.name);
  if (alias === null) return null;
  const copy = structuredClone(definition);
  function localize(node: DefinitionNode, path: string, root = false): void {
    const subcommand = node.type === ApplicationCommandOptionType.Subcommand
      || node.type === ApplicationCommandOptionType.SubcommandGroup;
    const names = root ? namesAt(commandNames, path) : subcommand ? namesAt(subcommandNames, path)
      : namesAt(optionOverrides, path) ?? namesAt(optionNames, node.name);
    if (!names) throw new Error(`Missing Simplified command localization: ${path}`);
    node.name_localizations = { ...node.name_localizations, 'zh-TW': names[1], 'zh-CN': names[1] };
    for (const choice of node.choices ?? []) {
      const choiceName = namesAt(choiceNames, choice.name);
      if (!choiceName) throw new Error(`Missing Simplified command choice: ${path}:${choice.name}`);
      choice.name_localizations = { ...choice.name_localizations, 'zh-TW': choiceName[1], 'zh-CN': choiceName[1] };
    }
    for (const child of node.options ?? []) localize(child, `${path}.${child.name}`);
  }
  localize(copy as unknown as DefinitionNode, definition.name, true);
  copy.name = alias;
  return copy;
}

function namedBuilder(value: unknown): NamedBuilder {
  if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string'
    || !('setNameLocalizations' in value) || typeof value.setNameLocalizations !== 'function') {
    throw new TypeError('Expected a Discord command builder with localization support.');
  }
  return value as NamedBuilder;
}

function localizeNode(node: NamedBuilder, path: string, root = false): void {
  const subcommand = node instanceof SlashCommandSubcommandBuilder
    || node instanceof SlashCommandSubcommandGroupBuilder;
  const names = root ? namesAt(commandNames, path) : subcommand ? namesAt(subcommandNames, path)
    : namesAt(optionOverrides, path) ?? namesAt(optionNames, node.name);
  node.setNameLocalizations({ ...node.name_localizations, ...localization(names, path) });
  if (node instanceof SlashCommandStringOption && node.choices) {
    node.setChoices(...node.choices.map((choice) => ({ ...choice,
      name_localizations: { ...choice.name_localizations, ...localization(namesAt(choiceNames, choice.name), `${path}:${choice.name}`) },
    })));
  } else if ('choices' in node && Array.isArray(node.choices) && node.choices.length) {
    throw new Error(`Unsupported command choice localization: ${path}`);
  }
  for (const value of node.options ?? []) {
    const child = namedBuilder(value);
    localizeNode(child, `${path}.${child.name}`);
  }
}

/** Preserve canonical names and values: Discord translates presentation, not interaction routing. */
export function localizeSlashCommand(builder: NamedBuilder): void {
  localizeNode(builder, builder.name, true);
}

export function localizeMessageCommand(builder: ContextMenuCommandBuilder): void {
  builder.setNameLocalizations(localization(namesAt(messageCommandNames, builder.name), builder.name));
}

/** Translate controlled help references while keeping unknown paths and non-Chinese locales intact. */
export function localizeCommandReferences(text: string, locale: string): string {
  const index = locale === 'zh-TW' || locale === 'zh-CN' ? 0 : null;
  if (index === null) return text;
  return text.replace(/\/([a-z][a-z0-9_-]*)(?:([ \t]+)([a-z][a-z0-9_-]*))?/g,
    (original, root: string, separator: string | undefined, child: string | undefined) => {
      const name = namesAt(commandNames, root);
      if (!name) return original;
      const childName = child ? namesAt(subcommandNames, `${root}.${child}`) : undefined;
      return `/${name[index]}${childName ? `${separator}${childName[index]}` : child ? `${separator}${child}` : ''}`;
    });
}
