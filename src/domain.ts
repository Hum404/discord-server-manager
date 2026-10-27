export const MANAGEMENT_SCOPES = ['warn', 'timeout', 'kick', 'ban', 'clear'] as const;
export type ManagementScope = typeof MANAGEMENT_SCOPES[number];

export const SCOPE_LABELS: Record<ManagementScope, string> = {
  warn: '警告與警告查詢', timeout: '禁言與解除禁言', kick: '踢出成員',
  ban: '封鎖與解除封鎖', clear: '清理訊息',
};

export function scopeForCommand(name: string): ManagementScope | null {
  switch (name) {
    case 'warn': case 'warnings': return 'warn';
    case 'timeout': case 'untimeout': return 'timeout';
    case 'kick': return 'kick';
    case 'ban': case 'unban': return 'ban';
    case 'clear': return 'clear';
    default: return null;
  }
}

export const APPEALABLE_ACTIONS = new Set(['warn', 'timeout', 'kick', 'ban', 'subarea-mute', 'subarea-kick']);
