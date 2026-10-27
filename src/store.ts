import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APPEALABLE_ACTIONS, MANAGEMENT_SCOPES, type ManagementScope } from './domain.js';

export const DEFAULT_WELCOME_MESSAGE = '歡迎 {user} 加入 {server}！你是第 {count} 位成員。';

export interface GuildSettings {
  guildId: string;
  logChannelId: string | null;
  welcomeChannelId: string | null;
  welcomeMessage: string;
  appealChannelId: string | null;
  subareaCategoryId: string | null;
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

export interface Grant {
  guildId: string;
  userId: string;
  scope: ManagementScope;
  grantedBy: string;
  createdAt: string;
}

export interface Appeal {
  id: number;
  guildId: string;
  caseId: number;
  userId: string;
  reason: string;
  status: 'open' | 'accepted' | 'rejected';
  createdAt: string;
  reviewerId: string | null;
  response: string | null;
  reviewedAt: string | null;
  channelId: string | null;
  messageId: string | null;
}

export interface Subarea {
  guildId: string;
  channelId: string;
  ownerId: string;
  createdAt: string;
}

export interface SubareaRestriction {
  guildId: string;
  channelId: string;
  userId: string;
  muted: boolean;
  kicked: boolean;
  originalAllow: string | null;
  originalDeny: string | null;
  moderatorId: string;
  reason: string;
  updatedAt: string;
}

type SettingsPatch = Partial<Pick<GuildSettings, 'logChannelId' | 'welcomeChannelId' | 'welcomeMessage' | 'appealChannelId' | 'subareaCategoryId'>>;
type NewWarning = Pick<Warning, 'guildId' | 'userId' | 'moderatorId' | 'reason'>;
type NewCase = Pick<ModerationCase, 'guildId' | 'action' | 'userId' | 'moderatorId' | 'reason'> & { details?: string };

const warningColumns = 'id, guild_id AS guildId, user_id AS userId, moderator_id AS moderatorId, reason, created_at AS createdAt';
const caseColumns = 'id, guild_id AS guildId, action, user_id AS userId, moderator_id AS moderatorId, reason, details, created_at AS createdAt';
const grantColumns = 'guild_id AS guildId, user_id AS userId, scope, granted_by AS grantedBy, created_at AS createdAt';
const appealColumns = `id, guild_id AS guildId, case_id AS caseId, user_id AS userId, reason, status,
  created_at AS createdAt, reviewer_id AS reviewerId, response, reviewed_at AS reviewedAt,
  channel_id AS channelId, message_id AS messageId`;
const subareaColumns = 'guild_id AS guildId, channel_id AS channelId, owner_id AS ownerId, created_at AS createdAt';
const restrictionColumns = `guild_id AS guildId, channel_id AS channelId, user_id AS userId, muted, kicked,
  original_allow AS originalAllow, original_deny AS originalDeny, moderator_id AS moderatorId,
  reason, updated_at AS updatedAt`;

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

function positiveId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Record id must be a positive safe integer.');
  return value;
}

function managementScope(value: ManagementScope): ManagementScope {
  if (!MANAGEMENT_SCOPES.includes(value)) throw new TypeError('Unknown management scope.');
  return value;
}

function appealStatus(value: Appeal['status']): Appeal['status'] {
  if (!['open', 'accepted', 'rejected'].includes(value)) throw new TypeError('Unknown appeal status.');
  return value;
}

function permissionBits(value: string | null): void {
  if (value !== null && (typeof value !== 'string' || !/^[0-9]{1,100}$/.test(value))) {
    throw new TypeError('Permission bits must be a nonnegative decimal string or null.');
  }
}

function hydrateRestriction(row: unknown): SubareaRestriction | null {
  if (row === undefined) return null;
  const value = row as Omit<SubareaRestriction, 'muted' | 'kicked'> & { muted: number; kicked: number };
  return { ...value, muted: value.muted === 1, kicked: value.kicked === 1 };
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
          welcome_message TEXT NOT NULL CHECK(length(welcome_message) BETWEEN 1 AND 2000),
          appeal_channel_id TEXT,
          subarea_category_id TEXT
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
        CREATE INDEX IF NOT EXISTS cases_user ON moderation_cases(user_id, guild_id, id DESC);
        CREATE TABLE IF NOT EXISTS management_grants (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK(scope IN ('warn', 'timeout', 'kick', 'ban', 'clear')),
          granted_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (guild_id, user_id, scope)
        );
        CREATE TABLE IF NOT EXISTS appeals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          case_id INTEGER NOT NULL REFERENCES moderation_cases(id),
          user_id TEXT NOT NULL,
          reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'accepted', 'rejected')),
          created_at TEXT NOT NULL,
          reviewer_id TEXT,
          response TEXT,
          reviewed_at TEXT,
          channel_id TEXT,
          message_id TEXT,
          UNIQUE (guild_id, case_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS appeals_guild ON appeals(guild_id, status, id DESC);
        CREATE INDEX IF NOT EXISTS appeals_user ON appeals(user_id, id DESC);
        CREATE TABLE IF NOT EXISTS subareas (
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (guild_id, channel_id)
        );
        CREATE INDEX IF NOT EXISTS subareas_owner ON subareas(guild_id, owner_id);
        CREATE TABLE IF NOT EXISTS subarea_restrictions (
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          muted INTEGER NOT NULL CHECK(muted IN (0, 1)),
          kicked INTEGER NOT NULL CHECK(kicked IN (0, 1)),
          original_allow TEXT,
          original_deny TEXT,
          moderator_id TEXT NOT NULL,
          reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (guild_id, channel_id, user_id),
          FOREIGN KEY (guild_id, channel_id) REFERENCES subareas(guild_id, channel_id) ON DELETE CASCADE
        );
      `);
      // Old installations have only the initial four settings columns.
      const settingsColumns = this.db.prepare('PRAGMA table_info(guild_settings)').all() as Array<{ name: string }>;
      for (const column of ['appeal_channel_id', 'subarea_category_id']) {
        if (!settingsColumns.some((entry) => entry.name === column)) {
          this.db.exec(`ALTER TABLE guild_settings ADD COLUMN ${column} TEXT`);
        }
      }
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
             welcome_channel_id AS welcomeChannelId, welcome_message AS welcomeMessage,
             appeal_channel_id AS appealChannelId, subarea_category_id AS subareaCategoryId
      FROM guild_settings WHERE guild_id = ?
    `).get(guildId) as unknown as GuildSettings | undefined;
    return row ?? {
      guildId, logChannelId: null, welcomeChannelId: null, welcomeMessage: DEFAULT_WELCOME_MESSAGE,
      appealChannelId: null, subareaCategoryId: null,
    };
  }

  updateSettings(guildId: string, patch: SettingsPatch): GuildSettings {
    const current = this.getSettings(guildId);
    const settings: GuildSettings = {
      ...current,
      logChannelId: patch.logChannelId === undefined ? current.logChannelId : patch.logChannelId,
      welcomeChannelId: patch.welcomeChannelId === undefined ? current.welcomeChannelId : patch.welcomeChannelId,
      welcomeMessage: patch.welcomeMessage === undefined ? current.welcomeMessage : patch.welcomeMessage,
      appealChannelId: patch.appealChannelId === undefined ? current.appealChannelId : patch.appealChannelId,
      subareaCategoryId: patch.subareaCategoryId === undefined ? current.subareaCategoryId : patch.subareaCategoryId,
    };
    if (settings.logChannelId !== null) identifier(settings.logChannelId);
    if (settings.welcomeChannelId !== null) identifier(settings.welcomeChannelId);
    if (settings.appealChannelId !== null) identifier(settings.appealChannelId);
    if (settings.subareaCategoryId !== null) identifier(settings.subareaCategoryId);
    requiredText(settings.welcomeMessage, 'Welcome message', 2000);
    this.db.prepare(`
      INSERT INTO guild_settings(guild_id, log_channel_id, welcome_channel_id, welcome_message, appeal_channel_id, subarea_category_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        log_channel_id = excluded.log_channel_id,
        welcome_channel_id = excluded.welcome_channel_id,
        welcome_message = excluded.welcome_message,
        appeal_channel_id = excluded.appeal_channel_id,
        subarea_category_id = excluded.subarea_category_id
    `).run(guildId, settings.logChannelId, settings.welcomeChannelId, settings.welcomeMessage,
      settings.appealChannelId, settings.subareaCategoryId);
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

  getCase(id: number): ModerationCase | null {
    return this.db.prepare(`SELECT ${caseColumns} FROM moderation_cases WHERE id = ?`)
      .get(positiveId(id)) as unknown as ModerationCase | undefined ?? null;
  }

  listUserCases(userId: string, guildId?: string, limit = 10): ModerationCase[] {
    identifier(userId);
    resultLimit(limit);
    if (guildId !== undefined) {
      identifier(guildId);
      return this.db.prepare(`SELECT ${caseColumns} FROM moderation_cases
        WHERE user_id = ? AND guild_id = ? ORDER BY id DESC LIMIT ?`)
        .all(userId, guildId, limit) as unknown as ModerationCase[];
    }
    return this.db.prepare(`SELECT ${caseColumns} FROM moderation_cases WHERE user_id = ? ORDER BY id DESC LIMIT ?`)
      .all(userId, limit) as unknown as ModerationCase[];
  }

  setGrant(guildId: string, userId: string, scope: ManagementScope, grantedBy: string): Grant {
    identifier(guildId);
    identifier(userId);
    identifier(grantedBy);
    managementScope(scope);
    const createdAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO management_grants(guild_id, user_id, scope, granted_by, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id, scope) DO UPDATE SET
      granted_by = excluded.granted_by, created_at = excluded.created_at`)
      .run(guildId, userId, scope, grantedBy, createdAt);
    return { guildId, userId, scope, grantedBy, createdAt };
  }

  setGrants(guildId: string, userId: string, scopes: ManagementScope[], grantedBy: string): Grant[] {
    identifier(guildId);
    identifier(userId);
    identifier(grantedBy);
    if (!Array.isArray(scopes) || scopes.length === 0 || new Set(scopes).size !== scopes.length) {
      throw new TypeError('Grant scopes must be a nonempty list of unique capabilities.');
    }
    scopes.forEach(managementScope);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const grants = scopes.map((scope) => this.setGrant(guildId, userId, scope, grantedBy));
      this.db.exec('COMMIT');
      return grants;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getGrant(guildId: string, userId: string, scope: ManagementScope): Grant | null {
    identifier(guildId);
    identifier(userId);
    managementScope(scope);
    return this.db.prepare(`SELECT ${grantColumns} FROM management_grants WHERE guild_id = ? AND user_id = ? AND scope = ?`)
      .get(guildId, userId, scope) as unknown as Grant | undefined ?? null;
  }

  revokeGrant(guildId: string, userId: string, scope?: ManagementScope): number {
    identifier(guildId);
    identifier(userId);
    if (scope !== undefined) {
      managementScope(scope);
      return Number(this.db.prepare('DELETE FROM management_grants WHERE guild_id = ? AND user_id = ? AND scope = ?')
        .run(guildId, userId, scope).changes);
    }
    return Number(this.db.prepare('DELETE FROM management_grants WHERE guild_id = ? AND user_id = ?')
      .run(guildId, userId).changes);
  }

  listGrants(guildId: string, userId?: string): Grant[] {
    identifier(guildId);
    if (userId !== undefined) {
      identifier(userId);
      return this.db.prepare(`SELECT ${grantColumns} FROM management_grants
        WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC, user_id, scope LIMIT 100`)
        .all(guildId, userId) as unknown as Grant[];
    }
    return this.db.prepare(`SELECT ${grantColumns} FROM management_grants WHERE guild_id = ?
      ORDER BY created_at DESC, user_id, scope LIMIT 100`).all(guildId) as unknown as Grant[];
  }

  createAppeal(input: Pick<Appeal, 'guildId' | 'caseId' | 'userId' | 'reason'>): Appeal {
    const { guildId, caseId, userId, reason } = input;
    identifier(guildId);
    positiveId(caseId);
    identifier(userId);
    requiredText(reason, 'Appeal reason', 1000);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const original = this.getCase(caseId);
      if (!original || original.guildId !== guildId || original.userId !== userId
        || !APPEALABLE_ACTIONS.has(original.action)) {
        throw new TypeError('The case cannot be appealed by this user in this guild.');
      }
      const createdAt = new Date().toISOString();
      const result = this.db.prepare(`INSERT INTO appeals(guild_id, case_id, user_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(guildId, caseId, userId, reason, createdAt);
      const appeal = this.getAppeal(Number(result.lastInsertRowid))!;
      this.db.exec('COMMIT');
      return appeal;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getAppeal(id: number): Appeal | null {
    return this.db.prepare(`SELECT ${appealColumns} FROM appeals WHERE id = ?`)
      .get(positiveId(id)) as unknown as Appeal | undefined ?? null;
  }

  getAppealForCase(guildId: string, caseId: number, userId: string): Appeal | null {
    identifier(guildId);
    positiveId(caseId);
    identifier(userId);
    return this.db.prepare(`SELECT ${appealColumns} FROM appeals WHERE guild_id = ? AND case_id = ? AND user_id = ?`)
      .get(guildId, caseId, userId) as unknown as Appeal | undefined ?? null;
  }

  listAppeals(guildId: string, status?: Appeal['status'], userId?: string, limit = 10): Appeal[] {
    identifier(guildId);
    const conditions = ['guild_id = ?'];
    const values: Array<string | number> = [guildId];
    if (status !== undefined) {
      conditions.push('status = ?');
      values.push(appealStatus(status));
    }
    if (userId !== undefined) {
      conditions.push('user_id = ?');
      values.push(identifier(userId));
    }
    values.push(resultLimit(limit));
    return this.db.prepare(`SELECT ${appealColumns} FROM appeals
      WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...values) as unknown as Appeal[];
  }

  listUserAppeals(userId: string, limit = 10): Appeal[] {
    identifier(userId);
    return this.db.prepare(`SELECT ${appealColumns} FROM appeals WHERE user_id = ? ORDER BY id DESC LIMIT ?`)
      .all(userId, resultLimit(limit)) as unknown as Appeal[];
  }

  reviewAppeal(id: number, guildId: string, reviewerId: string, status: 'accepted' | 'rejected', response: string): Appeal | null {
    positiveId(id);
    identifier(guildId);
    identifier(reviewerId);
    if (status !== 'accepted' && status !== 'rejected') throw new TypeError('A review must accept or reject the appeal.');
    requiredText(response, 'Appeal review response', 1000);
    const reviewedAt = new Date().toISOString();
    return this.db.prepare(`UPDATE appeals SET status = ?, reviewer_id = ?, response = ?, reviewed_at = ?
      WHERE id = ? AND guild_id = ? AND status = 'open' RETURNING ${appealColumns}`)
      .get(status, reviewerId, response, reviewedAt, id, guildId) as unknown as Appeal | undefined ?? null;
  }

  setAppealMessage(id: number, guildId: string, channelId: string, messageId: string): void {
    positiveId(id);
    identifier(guildId);
    identifier(channelId);
    identifier(messageId);
    const result = this.db.prepare('UPDATE appeals SET channel_id = ?, message_id = ? WHERE id = ? AND guild_id = ?')
      .run(channelId, messageId, id, guildId);
    if (result.changes === 0) throw new RangeError('The appeal does not exist in this guild.');
  }

  setSubarea(guildId: string, channelId: string, ownerId: string): Subarea {
    identifier(guildId);
    identifier(channelId);
    identifier(ownerId);
    const createdAt = new Date().toISOString();
    return this.db.prepare(`INSERT INTO subareas(guild_id, channel_id, owner_id, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, channel_id) DO UPDATE SET owner_id = excluded.owner_id RETURNING ${subareaColumns}`)
      .get(guildId, channelId, ownerId, createdAt) as unknown as Subarea;
  }

  getSubarea(guildId: string, channelId: string): Subarea | null {
    identifier(guildId);
    identifier(channelId);
    return this.db.prepare(`SELECT ${subareaColumns} FROM subareas WHERE guild_id = ? AND channel_id = ?`)
      .get(guildId, channelId) as unknown as Subarea | undefined ?? null;
  }

  listSubareas(guildId: string, ownerId?: string): Subarea[] {
    identifier(guildId);
    if (ownerId !== undefined) {
      identifier(ownerId);
      return this.db.prepare(`SELECT ${subareaColumns} FROM subareas WHERE guild_id = ? AND owner_id = ?
        ORDER BY created_at DESC, channel_id LIMIT 100`).all(guildId, ownerId) as unknown as Subarea[];
    }
    return this.db.prepare(`SELECT ${subareaColumns} FROM subareas WHERE guild_id = ?
      ORDER BY created_at DESC, channel_id LIMIT 100`).all(guildId) as unknown as Subarea[];
  }

  deleteSubarea(guildId: string, channelId: string): void {
    identifier(guildId);
    identifier(channelId);
    this.db.prepare('DELETE FROM subareas WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId);
  }

  getSubareaRestriction(guildId: string, channelId: string, userId: string): SubareaRestriction | null {
    identifier(guildId);
    identifier(channelId);
    identifier(userId);
    return hydrateRestriction(this.db.prepare(`SELECT ${restrictionColumns} FROM subarea_restrictions
      WHERE guild_id = ? AND channel_id = ? AND user_id = ?`).get(guildId, channelId, userId));
  }

  setSubareaRestriction(input: Omit<SubareaRestriction, 'updatedAt'>): SubareaRestriction {
    const { guildId, channelId, userId, muted, kicked, originalAllow, originalDeny, moderatorId, reason } = input;
    identifier(guildId);
    identifier(channelId);
    identifier(userId);
    identifier(moderatorId);
    if (typeof muted !== 'boolean' || typeof kicked !== 'boolean') throw new TypeError('Restriction flags must be boolean.');
    permissionBits(originalAllow);
    permissionBits(originalDeny);
    requiredText(reason, 'Restriction reason', 1000);
    if (!this.getSubarea(guildId, channelId)) throw new TypeError('The subarea does not exist in this guild.');
    const updatedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO subarea_restrictions
      (guild_id, channel_id, user_id, muted, kicked, original_allow, original_deny, moderator_id, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, channel_id, user_id) DO UPDATE SET
        muted = excluded.muted, kicked = excluded.kicked, original_allow = excluded.original_allow,
        original_deny = excluded.original_deny, moderator_id = excluded.moderator_id,
        reason = excluded.reason, updated_at = excluded.updated_at`)
      .run(guildId, channelId, userId, Number(muted), Number(kicked), originalAllow, originalDeny, moderatorId, reason, updatedAt);
    return { ...input, updatedAt };
  }

  deleteSubareaRestriction(guildId: string, channelId: string, userId: string): void {
    identifier(guildId);
    identifier(channelId);
    identifier(userId);
    this.db.prepare('DELETE FROM subarea_restrictions WHERE guild_id = ? AND channel_id = ? AND user_id = ?')
      .run(guildId, channelId, userId);
  }

  listSubareaRestrictions(guildId?: string): SubareaRestriction[] {
    const rows = guildId === undefined
      ? this.db.prepare(`SELECT ${restrictionColumns} FROM subarea_restrictions ORDER BY guild_id, channel_id, user_id`).all()
      : this.db.prepare(`SELECT ${restrictionColumns} FROM subarea_restrictions WHERE guild_id = ? ORDER BY channel_id, user_id`)
        .all(identifier(guildId));
    return rows.map((row) => hydrateRestriction(row)!);
  }
}
