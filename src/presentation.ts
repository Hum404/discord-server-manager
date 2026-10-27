import { escapeMarkdown } from 'discord.js';

/** Clip to a Discord UTF-16 length limit without cutting an emoji in half. */
export function truncate(text: string, limit: number): string {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('文字長度上限必須是大於等於 1 的整數。');
  }
  if (text.length <= limit) return text;

  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

export function formatWelcome(
  template: string,
  { userId, serverName, memberCount }: {
    userId: string;
    serverName: string;
    memberCount: number;
  },
): string {
  const values = {
    user: `<@${userId}>`,
    server: escapeMarkdown(serverName),
    count: String(memberCount),
  };
  // A single callback replacement keeps placeholders in inserted names literal.
  const result = template.replace(/\{(user|server|count)\}/g, (_match, key: keyof typeof values) => values[key]);
  return truncate(result, 2000);
}

export function recentMessageIds(
  messages: Iterable<{ id: string; createdTimestamp: number }>,
  now = Date.now(),
): string[] {
  // Leave time for Discord to receive the bulk-delete request near its 14-day limit.
  const cutoff = now - 14 * 24 * 60 * 60 * 1000 + 5000;
  const ids: string[] = [];
  for (const message of messages) {
    if (message.createdTimestamp > cutoff) ids.push(message.id);
  }
  return ids;
}
