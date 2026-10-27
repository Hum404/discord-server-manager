import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { REST } from 'discord.js';
import { resolveApplication } from './application.js';
import { logFailure } from './bot.js';
import { ConfigError, loadConfig } from './config.js';
import { listBotGuilds, readCommandState, syncCommandState, type BotGuild } from './command-sync.js';

function terminalName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 200);
}

async function chooseGuild(guilds: BotGuild[], configuredGuildId?: string): Promise<BotGuild> {
  if (configuredGuildId) {
    const configured = guilds.find((guild) => guild.id === configuredGuildId);
    if (!configured) throw new ConfigError('機器人尚未加入 DISCORD_GUILD_ID 指定的伺服器，未變更指令。');
    return configured;
  }
  if (!guilds.length) throw new ConfigError('機器人尚未加入任何伺服器，請先使用邀請網址授權。');
  if (guilds.length === 1) return guilds[0]!;
  if (!stdin.isTTY) throw new ConfigError('機器人加入了多個伺服器，請在 SSH 終端執行並選擇要清理的伺服器。');
  console.log('選擇要清理舊指令的伺服器：');
  guilds.forEach((guild, index) => console.log(`${index + 1}. ${terminalName(guild.name)}（${guild.id}）`));
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = (await terminal.question('輸入伺服器序號：')).trim();
      if (/^[0-9]+$/.test(answer)) {
        const selected = guilds[Number(answer) - 1];
        if (selected) return selected;
      }
      console.log('請輸入清單中的序號。');
    }
  } finally {
    terminal.close();
  }
}

try {
  const config = loadConfig();
  const rest = new REST({ version: '10' }).setToken(config.token);
  const application = await resolveApplication(rest);
  const guild = await chooseGuild(await listBotGuilds(rest), config.guildId);
  const state = await readCommandState(rest, application.id, guild.id);
  console.log(`伺服器：${terminalName(guild.name)}`);
  console.log(`目前此 Bot 的全域指令 ${state.global.length} 個；此伺服器專用指令 ${state.guild.length} 個。`);

  const backupDirectory = join(config.databasePath === ':memory:'
    ? resolve('data') : dirname(resolve(config.databasePath)), 'command-backups');
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backupPath = join(backupDirectory, `${application.id}-${guild.id}-${randomUUID()}.json`);
  await writeFile(backupPath, JSON.stringify({
    applicationId: application.id, guildId: guild.id, createdAt: new Date().toISOString(),
    mode: config.guildId ? 'guild' : 'global', ...state,
  }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log(`原指令清單已備份：${backupPath}`);
  console.log(config.guildId
    ? '正在同步此伺服器指令，並移除此 Bot 不再支援的全域指令。'
    : '正在同步此 Bot 的全域指令，並清除此伺服器的舊指令副本。');
  const result = await syncCommandState(rest, application.id, guild.id, state, Boolean(config.guildId));
  console.log(`同步完成並已向 Discord 驗證：目前版本 ${result.registered} 個指令。`);
  console.log(`已移除舊全域指令 ${result.removedGlobal} 個、舊伺服器指令 ${result.removedGuild} 個。`);
  console.log('請重新開啟 Discord 查看更新。若舊指令再次出現，請停止其他主機上仍在執行的舊版機器人。');
} catch (error) {
  if (error instanceof ConfigError) console.error(error.message);
  else logFailure('指令同步失敗：請檢查 Token、伺服器授權與網路連線；原指令清單若已備份則仍保留', error);
  process.exitCode = 1;
}
