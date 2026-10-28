import { InteractionContextType, Routes, type REST } from 'discord.js';
import { allCommands, commands } from './commands.js';
import { ConfigError } from './config.js';

const snowflake = /^[0-9]{17,20}$/;

/** Ask Discord which application owns the token instead of requiring a copied ID. */
export async function resolveApplication(
  rest: Pick<REST, 'get'>,
): Promise<{ id: string }> {
  const application = await rest.get(Routes.oauth2CurrentApplication());
  if (!application || typeof application !== 'object' || !('id' in application)
    || typeof application.id !== 'string' || !snowflake.test(application.id)) {
    throw new ConfigError('Discord 未回傳有效的應用程式資料，請確認 DISCORD_TOKEN 是 Bot Token。');
  }
  return { id: application.id };
}

export async function registerCommands(
  rest: Pick<REST, 'put'>,
  applicationId: string,
  guildId?: string,
): Promise<number> {
  if (!snowflake.test(applicationId) || (guildId !== undefined && !snowflake.test(guildId))) {
    throw new ConfigError('無法註冊指令：應用程式或伺服器 ID 格式無效。');
  }
  const definitions = allCommands.map((command) => command.toJSON());
  const body = guildId
    ? definitions.map(({ contexts: _contexts, integration_types: _integrationTypes, ...command }) => command)
    : definitions;
  await rest.put(guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId), { body });
  return allCommands.length;
}

/** Guild-only deployments still need a global DM entry point for appeals. */
export async function registerDmAppeal(
  rest: Pick<REST, 'post'>,
  applicationId: string,
): Promise<void> {
  if (!snowflake.test(applicationId)) {
    throw new ConfigError('無法註冊私訊申訴指令：應用程式 ID 格式無效。');
  }
  const appeal = commands.find((command) => command.name === 'appeal');
  if (!appeal) throw new ConfigError('找不到申訴指令，請更新完整程式後再試。');
  await rest.post(Routes.applicationCommands(applicationId), {
    body: { ...appeal.toJSON(), contexts: [InteractionContextType.BotDM] },
  });
}
