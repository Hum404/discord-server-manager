import { SERVER_AUDIT_ACTIONS } from './audit-policy.js';

export type NoticeKind = 'management' | 'subarea';

/** Public server notifications cover only server-wide sanctions and their reversals. */
export const MANAGEMENT_NOTICE_ACTIONS = SERVER_AUDIT_ACTIONS;

/** Deleted areas cannot receive a notice; mention commands already send their own notices. */
export const SUBAREA_NOTICE_ACTIONS = [
  'subarea-mute', 'subarea-unmute', 'subarea-kick', 'subarea-unkick',
  'subarea-create', 'subarea-assign', 'subarea-delegate', 'subarea-undelegate',
  'subarea-pin', 'subarea-unpin', 'subarea-delete-message', 'subarea-slowmode',
  'subarea-rename', 'subarea-lock', 'subarea-unlock',
] as const;

export const NOTICE_ACTION_LABELS: Record<string, string> = {
  warn: '警告', timeout: '伺服器禁言', untimeout: '解除伺服器禁言',
  kick: '踢出伺服器', ban: '封鎖', unban: '解除封鎖', 'warning-remove': '撤銷警告',
  'subarea-mute': '子區禁言', 'subarea-unmute': '解除子區禁言',
  'subarea-kick': '移除子區成員', 'subarea-unkick': '恢復子區成員',
  'subarea-create': '建立子區', 'subarea-assign': '指派子區建立者',
  'subarea-delegate': '設定協管', 'subarea-undelegate': '撤回協管',
  'subarea-pin': '置頂訊息', 'subarea-unpin': '取消置頂',
  'subarea-delete-message': '刪除訊息', 'subarea-slowmode': '調整慢速模式',
  'subarea-rename': '修改子區名稱', 'subarea-lock': '鎖定子區', 'subarea-unlock': '解鎖子區',
};

export function notificationActionsFor(kind: NoticeKind): readonly string[] {
  switch (kind) {
    case 'management': return MANAGEMENT_NOTICE_ACTIONS;
    case 'subarea': return SUBAREA_NOTICE_ACTIONS;
    default: throw new TypeError('Unknown notification kind.');
  }
}
