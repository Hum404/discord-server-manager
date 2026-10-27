import { REST } from 'discord.js';
import { ConfigError, loadConfig } from './config.js';
import { registerCommands, resolveApplication } from './application.js';

try {
  const { token, guildId } = loadConfig();
  const rest = new REST({ version: '10' }).setToken(token);
  const application = await resolveApplication(rest);
  const count = await registerCommands(rest, application.id, guildId);
  if (guildId) {
    console.log(`已將 ${count} 個斜線指令註冊至指定伺服器。`);
  } else {
    console.log(`已註冊 ${count} 個全域斜線指令；Discord 可能需要一段時間才會顯示更新。`);
  }
} catch (error: unknown) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'number' ? error.code : undefined;
    console.error(`註冊失敗。請確認 Token、伺服器存取權限與網路連線。${code === undefined ? '' : `（Discord 錯誤碼：${code}）`}`);
  }
  process.exitCode = 1;
}
