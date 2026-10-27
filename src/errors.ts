export class UserError extends Error {}

/** REST errors can contain credentials; keep logs limited to safe error codes. */
export function logFailure(context: string, error: unknown): void {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const safeCode = typeof code === 'number' || (typeof code === 'string' && /^[A-Z_0-9]{1,50}$/.test(code))
    ? String(code) : 'UNKNOWN';
  console.error(`${context}（代碼：${safeCode}）`);
}

export function errorMessage(error: unknown): string {
  if (error instanceof UserError) return error.message;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 50013: return 'Discord 拒絕操作：請檢查機器人權限及角色階級。';
    case 50001: return '機器人無法存取此頻道或伺服器，請檢查權限。';
    case 10007: return '找不到此成員，對方可能已離開伺服器。';
    case 10026: return '此使用者不在封鎖名單中。';
    case 10003: return '找不到此頻道，請重新設定。';
    default: return '操作未能完成，請稍後再試；若涉及成員異動，請先檢查目前狀態。';
  }
}
