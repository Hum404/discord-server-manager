import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { ConfigError, loadConfig } from './config.js';
import { handleInteraction, logFailure, welcomeMember } from './bot.js';
import { Store } from './store.js';
import { registerCommands, registerDmAppeal, resolveApplication } from './application.js';
import { handleSubareaChannelDelete, reconcileSubareaRestrictions } from './subareas.js';
import { reconcileSubareaLocks } from './subarea-tools.js';
import { handleSubareaThreadMessage, handleSubareaThreadReaction } from './subarea-threads.js';

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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    allowedMentions: { parse: [], repliedUser: false },
  });
  client.once(Events.ClientReady, (ready) => {
    console.log(`已登入 ${ready.user.tag}，目前服務 ${ready.guilds.cache.size} 個伺服器。`);
    console.log('指令與訊息 APP 選單已自動註冊，使用 /help 查看說明。');
    if (!stopping) track((async () => {
      await reconcileSubareaLocks(ready, database);
      if (!stopping) await reconcileSubareaRestrictions(ready, database);
    })());
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!stopping) track(handleInteraction(interaction, database));
  });
  client.on(Events.GuildMemberAdd, (member) => {
    if (!stopping) track(welcomeMember(member, database));
  });
  client.on(Events.MessageCreate, (message) => {
    if (!stopping) track(handleSubareaThreadMessage(message, database));
  });
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    if (!stopping) track(handleSubareaThreadReaction(reaction, user, database));
  });
  client.on(Events.ChannelDelete, (channel) => {
    if (!stopping && 'guild' in channel) {
      try { handleSubareaChannelDelete(channel, database); }
      catch (error) { logFailure('子區資料清理失敗', error); }
    }
  });
  client.on(Events.ThreadDelete, (thread) => {
    if (!stopping) {
      try { handleSubareaChannelDelete(thread, database); }
      catch (error) { logFailure('討論串子區資料清理失敗', error); }
    }
  });
  client.on(Events.Error, (error) => logFailure('Discord 連線錯誤', error));
  client.on(Events.ShardError, (error) => logFailure('Discord Gateway 錯誤', error));
  client.on(Events.Warn, () => console.warn('Discord 發出連線警告，請檢查連線與伺服器設定。'));
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  const rest = client.rest.setToken(config.token);
  const application = await resolveApplication(rest);
  if (!stopping) {
    const count = await registerCommands(rest, application.id, config.guildId);
    if (config.guildId && !stopping) await registerDmAppeal(rest, application.id);
    console.log(`已自動註冊 ${count} 個${config.guildId ? '伺服器' : '全域'}指令。`);
    if (!config.guildId) console.log('全域指令可能需要一段時間才會顯示更新。');
    if (!stopping) await client.login(config.token);
  }
} catch (error) {
  if (error instanceof ConfigError) console.error(error.message);
  else logFailure('機器人啟動失敗：請檢查 Token、Server Members Intent、資料路徑及網路連線', error);
  await shutdown();
  process.exitCode = 1;
}
