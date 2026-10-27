import { config as loadDotenv } from 'dotenv';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { ConfigError, parseClientId } from './config.js';

try {
  loadDotenv({ quiet: true });
  const clientId = parseClientId(process.env.DISCORD_CLIENT_ID);
  const permissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
  ]);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'bot applications.commands');
  url.searchParams.set('permissions', permissions.bitfield.toString());
  console.log('請使用以下連結將機器人加入你有管理權限的伺服器：');
  console.log(url.toString());
} catch (error: unknown) {
  console.error(error instanceof ConfigError ? error.message : '無法產生邀請連結，請檢查 DISCORD_CLIENT_ID。');
  process.exitCode = 1;
}
