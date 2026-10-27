import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_WELCOME_MESSAGE = '歡迎 {user} 加入 {server}！你是第 {count} 位成員。';

export interface GuildSettings {
  guildId: string;
  logChannelId: string | null;
  welcomeChannelId: string | null;
  welcomeMessage: string;
}

export interface Warning {
  id: number;
  guildId: string;
  userId: string;
  moderatorId: string;
  reason: string;
  createdAt: string;
}

export interface ModerationCase {
  id: number;
  guildId: string;
  action: string;
  userId: string | null;
  moderatorId: string;
  reason: string;
  details: string | null;
  createdAt: string;
}

type SettingsPatch = Partial<Pick<GuildSettings, 'logChannelId' | 'welcomeChannelId' | 'welcomeMessage'>>;
type NewWarning = Pick<Warning, 'guildId' | 'userId' | 'moderatorId' | 'reason'>;
type NewCase = Pick<ModerationCase, 'guildId' | 'action' | 'userId' | 'moderatorId' | 'reason'> & { details?: string };

const warningColumns = 'id, guild_id AS guildId, user_id AS userId, moderator_id AS moderatorId, reason, created_at AS createdAt';
const caseColumns = 'id, guild_id AS guildId, action, user_id AS userId, moderator_id AS moderatorId, reason, details, created_at AS createdAt';

function requiredText(value: string, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new TypeError(`${name} must contain 1–${maximum} characters.`);
  }
  return value;
}

function identifier(value: string): string {
  return requiredText(value, 'Identifier', 64);
}

function resultLimit(value = 10): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError('The result limit must be an integer from 1 to 100.');
  }
  return value;
}

/** One SQLite connection per bot process. Every query is scoped to its guild. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    requiredText(path, 'Database path', 4096);
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS guild_settings (
          guild_id TEXT PRIMARY KEY,
          log_channel_id TEXT,
          welcome_channel_id TEXT,
          welcome_message TEXT NOT NULL CHECK(length(welcome_message) BETWEEN 1 AND 2000)
        );
        CREATE TABLE IF NOT EXISTS warnings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          moderator_id TEXT NOT NULL,
          reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS warnings_guild_user ON warnings(guild_id, user_id, id DESC);
        CREATE TABLE IF NOT EXISTS moderation_cases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 64),
          user_id TEXT,
          moderator_id TEXT NOT NULL,
          reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
          details TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cases_guild ON moderation_cases(guild_id, id DESC);
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  getSettings(guildId: string): GuildSettings {
    identifier(guildId);
    const row = this.db.prepare(`
      SELECT guild_id AS guildId, log_channel_id AS logChannelId,
             welcome_channel_id AS welcomeChannelId, welcome_message AS welcomeMessage
      FROM guild_settings WHERE guild_id = ?
    `).get(guildId) as unknown as GuildSettings | undefined;
    return row ?? { guildId, logChannelId: null, welcomeChannelId: null, welcomeMessage: DEFAULT_WELCOME_MESSAGE };
  }

  updateSettings(guildId: string, patch: SettingsPatch): GuildSettings {
    const current = this.getSettings(guildId);
    const settings: GuildSettings = {
      ...current,
      logChannelId: patch.logChannelId === undefined ? current.logChannelId : patch.logChannelId,
      welcomeChannelId: patch.welcomeChannelId === undefined ? current.welcomeChannelId : patch.welcomeChannelId,
      welcomeMessage: patch.welcomeMessage === undefined ? current.welcomeMessage : patch.welcomeMessage,
    };
    if (settings.logChannelId !== null) identifier(settings.logChannelId);
    if (settings.welcomeChannelId !== null) identifier(settings.welcomeChannelId);
    requiredText(settings.welcomeMessage, 'Welcome message', 2000);
    this.db.prepare(`
      INSERT INTO guild_settings(guild_id, log_channel_id, welcome_channel_id, welcome_message)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        log_channel_id = excluded.log_channel_id,
        welcome_channel_id = excluded.welcome_channel_id,
        welcome_message = excluded.welcome_message
    `).run(guildId, settings.logChannelId, settings.welcomeChannelId, settings.welcomeMessage);
    return settings;
  }

  addWarning(input: NewWarning): Warning {
    const { guildId, userId, moderatorId, reason } = input;
    identifier(guildId);
    identifier(userId);
    identifier(moderatorId);
    requiredText(reason, 'Reason', 1000);
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO warnings(guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(guildId, userId, moderatorId, reason, createdAt);
    return { id: Number(result.lastInsertRowid), guildId, userId, moderatorId, reason, createdAt };
  }

  listWarnings(guildId: string, userId: string, limit = 10): Warning[] {
    identifier(guildId);
    identifier(userId);
    return this.db.prepare(`
      SELECT ${warningColumns} FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?
    `).all(guildId, userId, resultLimit(limit)) as unknown as Warning[];
  }

  countWarnings(guildId: string, userId: string): number {
    identifier(guildId);
    identifier(userId);
    const row = this.db.prepare('SELECT count(*) AS count FROM warnings WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId) as { count: number };
    return row.count;
  }

  addCase(input: NewCase): ModerationCase {
    const { guildId, action, userId, moderatorId, reason } = input;
    identifier(guildId);
    if (userId !== null) identifier(userId);
    identifier(moderatorId);
    requiredText(action, 'Action', 64);
    requiredText(reason, 'Reason', 1000);
    const details = input.details ?? null;
    if (details !== null && (typeof details !== 'string' || details.length > 4000)) {
      throw new TypeError('Case details must contain at most 4000 characters.');
    }
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO moderation_cases(guild_id, action, user_id, moderator_id, reason, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, action, userId, moderatorId, reason, details, createdAt);
    return { id: Number(result.lastInsertRowid), guildId, action, userId, moderatorId, reason, details, createdAt };
  }

  listCases(guildId: string, limit = 10): ModerationCase[] {
    identifier(guildId);
    return this.db.prepare(`
      SELECT ${caseColumns} FROM moderation_cases WHERE guild_id = ? ORDER BY id DESC LIMIT ?
    `).all(guildId, resultLimit(limit)) as unknown as ModerationCase[];
  }
}
