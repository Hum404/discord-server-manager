export type AuditScope = 'server' | 'member';

/** Only server-wide sanctions and their reversals belong in the public server log. */
export const SERVER_AUDIT_ACTIONS = [
  'warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'warning-remove',
] as const;

const serverActions = new Set<string>(SERVER_AUDIT_ACTIONS);

export function auditScopeForAction(action: string): AuditScope {
  return serverActions.has(action) ? 'server' : 'member';
}
