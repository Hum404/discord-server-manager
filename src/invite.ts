import { PermissionFlagsBits, PermissionsBitField, REST } from 'discord.js';
import { ConfigError, loadConfig } from './config.js';
import { resolveApplication } from './application.js';

try {
  const { token } = loadConfig();
  const rest = new REST({ version: '10' }).setToken(token);
  const application = await resolveApplication(rest);
  const permissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.MentionEveryone,
  ]);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', application.id);
  url.searchParams.set('scope', 'bot applications.commands');
  url.searchParams.set('permissions', permissions.bitfield.toString());
  console.log('請使用以下連結將機器人加入你有管理權限的伺服器：');
  console.log(url.toString());
} catch (error: unknown) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'number' ? error.code : undefined;
    console.error(`無法產生邀請連結，請確認 Token 與網路連線。${code === undefined ? '' : `（Discord 錯誤碼：${code}）`}`);
  }
  process.exitCode = 1;
}
