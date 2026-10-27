import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { ConfigError, loadConfig } from './config.js';

try {
  const { token, clientId, guildId } = loadConfig();
  const rest = new REST({ version: '10' }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  const definitions = commands.map((command) => command.toJSON());
  // Discord only accepts contexts/integration_types for global commands.
  const body = guildId
    ? definitions.map(({ contexts: _contexts, integration_types: _integrationTypes, ...command }) => command)
    : definitions;

  await rest.put(route, { body });
  if (guildId) {
    console.log(`已將 ${commands.length} 個斜線指令註冊至指定伺服器。`);
  } else {
    console.log(`已註冊 ${commands.length} 個全域斜線指令；Discord 可能需要一段時間才會顯示更新。`);
  }
} catch (error: unknown) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'number' ? error.code : undefined;
    console.error(`註冊失敗。請確認 Token、應用程式 ID 與伺服器存取權限。${code === undefined ? '' : `（Discord 錯誤碼：${code}）`}`);
  }
  process.exitCode = 1;
}
