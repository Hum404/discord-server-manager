import { config as loadDotenv } from 'dotenv';

export interface BotConfig {
  token: string;
  guildId: string | undefined;
  databasePath: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const snowflakePattern = /^\d{17,20}$/;
const placeholderPattern = /^(?:your[\s_-]|replace[\s_-]|paste[\s_-]|example|placeholder|change[\s_-]|<|請|填入|貼上)/i;

export function parseConfig(env: Record<string, string | undefined>): BotConfig {
  const token = env.DISCORD_TOKEN?.trim();
  if (!token || placeholderPattern.test(token)) {
    throw new ConfigError('請在 .env 設定有效的 DISCORD_TOKEN，請勿使用範例文字。');
  }

  const guildId = env.DISCORD_GUILD_ID?.trim() || undefined;
  if (guildId && !snowflakePattern.test(guildId)) {
    throw new ConfigError('DISCORD_GUILD_ID 必須是 17 至 20 位數字；若使用全域指令，請留空。');
  }

  const databasePath = env.DATABASE_PATH?.trim() || './data/bot.sqlite';
  if (databasePath.includes('\0')) {
    throw new ConfigError('DATABASE_PATH 不能包含空字元。');
  }
  return { token, guildId, databasePath };
}

export function loadConfig(): BotConfig {
  loadDotenv({ quiet: true });
  return parseConfig(process.env);
}
