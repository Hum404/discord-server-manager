import { ApplicationCommandType, ApplicationIntegrationType, Routes, type REST } from 'discord.js';
import { registerCommands } from './application.js';
import { allCommands } from './commands.js';
import { ConfigError } from './config.js';

export interface BotGuild {
  id: string;
  name: string;
}

export interface SavedCommand {
  id: string;
  name: string;
  type: number;
  [key: string]: unknown;
}

export interface CommandState {
  global: SavedCommand[];
  guild: SavedCommand[];
}

const snowflake = /^[0-9]{17,20}$/;
const pageSize = 200;
const verificationError = '無法確認指令同步結果；可能仍有舊程式重新註冊，請停止舊程式後再試。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !snowflake.test(value)) {
    throw new ConfigError('無法同步指令：應用程式或伺服器 ID 格式無效。');
  }
}

function commandKey(command: Pick<SavedCommand, 'type' | 'name'>): string {
  return `${command.type}:${command.name}`;
}

function optionalList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ConfigError(verificationError);
  return value;
}

function numericList(value: unknown): number[] {
  const values = optionalList(value);
  if (!values.every((entry): entry is number => typeof entry === 'number' && Number.isSafeInteger(entry))) {
    throw new ConfigError(verificationError);
  }
  return [...values].sort((left, right) => left - right);
}

function optionDefinition(value: unknown): unknown {
  if (!isRecord(value)) throw new ConfigError(verificationError);
  return {
    type: value.type,
    name: value.name,
    description: value.description ?? '',
    required: value.required ?? false,
    autocomplete: value.autocomplete ?? false,
    options: optionalList(value.options).map(optionDefinition),
    choices: optionalList(value.choices).map((choice) => {
      if (!isRecord(choice)) throw new ConfigError(verificationError);
      return { name: choice.name, value: choice.value };
    }),
    channel_types: numericList(value.channel_types),
    min_value: value.min_value ?? null,
    max_value: value.max_value ?? null,
    // Discord's omitted string limits mean 0 through 6000 characters.
    min_length: value.min_length ?? (value.type === 3 ? 0 : null),
    max_length: value.max_length ?? (value.type === 3 ? 6000 : null),
  };
}

/** Compare functional fields while ignoring API IDs, versions and added defaults. */
function commandDefinition(value: Record<string, unknown>, guildOnly: boolean): string {
  return JSON.stringify({
    type: value.type ?? 1,
    name: value.name,
    description: value.description ?? '',
    options: optionalList(value.options).map(optionDefinition),
    default_member_permissions: value.default_member_permissions == null
      ? null : String(value.default_member_permissions),
    nsfw: value.nsfw ?? false,
    contexts: guildOnly ? null : numericList(value.contexts),
    integration_types: guildOnly || value.type !== ApplicationCommandType.Message
      ? null : numericList(value.integration_types ?? [ApplicationIntegrationType.GuildInstall]),
  });
}

function validateCommands(value: unknown): SavedCommand[] {
  if (!Array.isArray(value)) throw new ConfigError('Discord 回傳的指令資料格式無效。');
  const ids = new Set<string>();
  const keys = new Set<string>();
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) throw new ConfigError('Discord 回傳的指令資料格式無效。');
    const type = entry.type === undefined ? 1 : entry.type;
    if (typeof entry.id !== 'string' || !snowflake.test(entry.id)
      || typeof entry.name !== 'string' || !entry.name.trim()
      || typeof type !== 'number' || !Number.isSafeInteger(type) || type < 1) {
      throw new ConfigError('Discord 回傳的指令資料格式無效。');
    }
    const command: SavedCommand = { ...entry, id: entry.id, name: entry.name, type };
    const key = commandKey(command);
    if (ids.has(command.id) || keys.has(key)) {
      throw new ConfigError('Discord 回傳了重複的指令資料，請稍後再試。');
    }
    ids.add(command.id);
    keys.add(key);
    return command;
  });
}

function validateState(value: unknown): CommandState {
  if (!isRecord(value)) throw new ConfigError('指令備份資料格式無效。');
  return { global: validateCommands(value.global), guild: validateCommands(value.guild) };
}

/** Read all pages before allowing the caller to choose a server or make changes. */
export async function listBotGuilds(rest: Pick<REST, 'get'>): Promise<BotGuild[]> {
  const result: BotGuild[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (after) query.set('after', after);
    const page = await rest.get(Routes.userGuilds(), { query });
    if (!Array.isArray(page) || page.length > pageSize) {
      throw new ConfigError('Discord 回傳的伺服器清單格式無效。');
    }
    let next = after;
    for (const value of page as unknown[]) {
      if (!isRecord(value) || typeof value.id !== 'string' || !snowflake.test(value.id)
        || typeof value.name !== 'string' || !value.name.trim()) {
        throw new ConfigError('Discord 回傳的伺服器清單格式無效。');
      }
      if (seen.has(value.id) || (after !== undefined && BigInt(value.id) <= BigInt(after))) {
        throw new ConfigError('Discord 伺服器清單分頁重複，未執行指令同步；請稍後再試。');
      }
      seen.add(value.id);
      result.push({ id: value.id, name: value.name });
      if (next === undefined || BigInt(value.id) > BigInt(next)) next = value.id;
    }
    if (page.length < pageSize) return result;
    if (next === undefined || next === after) {
      throw new ConfigError('Discord 伺服器清單分頁未前進，未執行指令同步；請稍後再試。');
    }
    after = next;
  }
}

export async function readCommandState(
  rest: Pick<REST, 'get'>, appId: string, guildId: string,
): Promise<CommandState> {
  assertId(appId);
  assertId(guildId);
  const [global, guild] = await Promise.all([
    rest.get(Routes.applicationCommands(appId)),
    rest.get(Routes.applicationGuildCommands(appId, guildId)),
  ]);
  return { global: validateCommands(global), guild: validateCommands(guild) };
}

/** Synchronize only this application and the selected server after a backup. */
export async function syncCommandState(
  rest: Pick<REST, 'get' | 'put' | 'delete'>,
  appId: string,
  guildId: string,
  state: CommandState,
  guildOnly: boolean,
): Promise<{ registered: number; removedGuild: number; removedGlobal: number }> {
  assertId(appId);
  assertId(guildId);
  const saved = validateState(state);
  const definitions = new Map(allCommands.map((command) => {
    const definition = command.toJSON();
    return [
      commandKey({ name: definition.name, type: definition.type ?? 1 }),
      commandDefinition(definition as unknown as Record<string, unknown>, guildOnly),
    ];
  }));
  const expected = new Set(definitions.keys());
  const staleGlobal = saved.global.filter((command) => !expected.has(commandKey(command)));
  const staleGuild = saved.guild.filter((command) => !expected.has(commandKey(command)));

  // Always install working current commands before removing a legacy source.
  const registered = await registerCommands(rest, appId, guildOnly ? guildId : undefined);
  if (guildOnly) {
    for (const command of staleGlobal) {
      await rest.delete(Routes.applicationCommand(appId, command.id));
    }
  } else if (saved.guild.length > 0) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [] });
  }

  let actual: CommandState;
  try {
    actual = await readCommandState(rest, appId, guildId);
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(verificationError);
    throw error;
  }
  const exact = (entries: SavedCommand[]) => entries.length === expected.size
    && entries.every((command) => definitions.get(commandKey(command)) === commandDefinition(command, guildOnly));
  const verified = guildOnly
    ? exact(actual.guild) && actual.global.every((command) => expected.has(commandKey(command)))
    : exact(actual.global) && actual.guild.length === 0;
  if (!verified) throw new ConfigError(verificationError);

  return {
    registered,
    removedGuild: guildOnly ? staleGuild.length : saved.guild.length,
    removedGlobal: staleGlobal.length,
  };
}
