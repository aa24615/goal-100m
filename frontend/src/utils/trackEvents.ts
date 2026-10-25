/**
 * 埋点事件白名单（RQ-74）。
 *
 * 与后端 `backend/src/services/analyticsService.js` 的 EVENTS 严格一一对应。
 * 前端只认这张表：拼错事件名会在开发期直接告警，而不是「写了埋点却永远不上报」。
 * 新增事件必须**先加后端再加这里**，否则会被后端 400 丢弃。
 */
export const TRACK_EVENTS = [
  'replay_start',
  'replay_finish',
  'review_view',
  'room_join',
  'room_create',
  'guide_complete',
  'task_complete',
  'checkin',
  'export_review',
  'share_card',
  'blind_start',
  'blind_decision',
  'blind_finish',
  'checkup_view',
] as const;

export type TrackEvent = (typeof TRACK_EVENTS)[number];
