import { Client, Events, GatewayIntentBits } from 'discord.js';
import { ConfigError, loadConfig } from './config.js';
import { handleInteraction, logFailure, welcomeMember } from './bot.js';
import { Store } from './store.js';

let client: Client | undefined;
let store: Store | undefined;
let stopping = false;
let shutdownPromise: Promise<void> | undefined;
const pending = new Set<Promise<void>>();

function track(task: Promise<void>): void {
  pending.add(task);
  void task.then(() => pending.delete(task), (error) => {
    pending.delete(task);
    logFailure('事件處理失敗', error);
  });
}

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    try { await client?.destroy(); } catch (error) { logFailure('Discord 連線關閉失敗', error); }
    // Finish acknowledged interactions before closing the database they use.
    await Promise.allSettled([...pending]);
    try { store?.close(); } catch (error) { logFailure('資料庫關閉失敗', error); }
  })();
  return shutdownPromise;
}

try {
  const config = loadConfig();
  store = new Store(config.databasePath);
  const database = store;
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    allowedMentions: { parse: [], repliedUser: false },
  });
  client.once(Events.ClientReady, (ready) => {
    if (ready.user.id !== config.clientId) {
      console.error('DISCORD_CLIENT_ID 與登入機器人不符，請更正設定。');
      void shutdown();
      process.exitCode = 1;
      return;
    }
    console.log(`已登入 ${ready.user.tag}，目前服務 ${ready.guilds.cache.size} 個伺服器。`);
    console.log('使用 /help 查看指令；首次啟動請先執行 npm run register。');
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!stopping) track(handleInteraction(interaction, database));
  });
  client.on(Events.GuildMemberAdd, (member) => {
    if (!stopping) track(welcomeMember(member, database));
  });
  client.on(Events.Error, (error) => logFailure('Discord 連線錯誤', error));
  client.on(Events.ShardError, (error) => logFailure('Discord Gateway 錯誤', error));
  client.on(Events.Warn, () => console.warn('Discord 發出連線警告，請檢查連線與伺服器設定。'));
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  await client.login(config.token);
} catch (error) {
  if (error instanceof ConfigError) console.error(error.message);
  else logFailure('機器人啟動失敗：請檢查 Token、Server Members Intent、資料路徑及網路連線', error);
  await shutdown();
  process.exitCode = 1;
}
