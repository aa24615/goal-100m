// 外部真实用户邀请与归因（RQ-159）

import express from 'express';
import pool from '../db.js';
import { authMiddleware } from '../auth.js';
import { asyncHandler, businessError } from '../middleware.js';
import { clampLimit } from '../utils/num.js';
import {
  createInvites,
  inviteFunnel,
  bindInvite,
  normalizeInviteCode,
  INVITE_GOAL,
  INVITE_STEPS,
  MAX_BATCH,
} from '../services/inviteService.js';

const router = express.Router();

function queryFn() {
  return (sql, params) => pool.query(sql, params);
}

/**
 * 生成邀请码。
 *
 * 必须登录：邀请码会绑定 `created_by`，匿名建码会让「谁邀请的」这条归因链断在最前面，
 * 而 RQ-159 的 5 份路径记录要求能回访到人。
 *
 * body: { count, channel, label }
 */
router.post(
  '/invite/codes',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const count = Math.max(1, Math.min(MAX_BATCH, Number(req.body?.count) || 1));
    const channel = String(req.body?.channel || 'manual').trim().slice(0, 40) || 'manual';
    const label = String(req.body?.label || '').trim().slice(0, 120) || null;
    const baseUrl = String(process.env.PUBLIC_BASE_URL || '').trim() || null;

    const r = await createInvites({
      count,
      channel,
      label,
      createdBy: req.userId ?? null,
      baseUrl,
      queryFn: queryFn(),
    });
    res.status(r.written > 0 ? 201 : 200).json({
      ...r,
      // 公网未就绪时链接是相对路径：仍然可用（前端拼 origin），但要说清楚
      publicReady: Boolean(baseUrl),
      hint: baseUrl ? null : 'PUBLIC_BASE_URL 未配置，生成的是相对路径；公网就绪后重新生成即可拿到完整链接（RQ-156）',
    });
  })
);

/**
 * 邀请漏斗（RQ-159 主判据）。
 *
 * 返回每个码的四步路径 —— 验收要的是「5 份路径记录 + 每步流失点」，
 * 只给聚合转化率无法满足「回访到人」这一条。
 *
 * query: { days, limit, goalRegistered, goalEffective }
 */
router.get(
  '/invite/funnel',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const days = req.query?.days === undefined || req.query?.days === '' ? null : Number(req.query.days);
    const limit = clampLimit(req.query?.limit, 500, 200);
    const goal = {
      registered: Number(req.query?.goalRegistered) || INVITE_GOAL.registered,
      effective: Number(req.query?.goalEffective) || INVITE_GOAL.effective,
    };
    const r = await inviteFunnel({ days, limit, goal, queryFn: queryFn() });
    res.json({ ...r, steps: INVITE_STEPS.map((s) => s.key), goal: r.goal });
  })
);

/** 邀请码列表（含每人路径），便于运营逐个回访 */
router.get(
  '/invite/codes',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const limit = clampLimit(req.query?.limit, 500, 200);
    const r = await inviteFunnel({ limit, queryFn: queryFn() });
    res.json({ total: r.counts?.created ?? 0, codes: r.paths || [], met: r.met, goal: r.goal });
  })
);

/**
 * 手动补绑邀请码（补偿路径）。
 *
 * 存在的理由：已经注册过的用户（比如早期被口头邀请的）没有走带码注册，
 * 没有这个口子就只能改库。补偿路径刻意**不覆盖已有归属**（见 bindInvite）。
 */
router.post(
  '/invite/bind',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const code = normalizeInviteCode(req.body?.code);
    if (!code) throw businessError('邀请码为空或含非法字符', 400);
    const r = await bindInvite({ code, userId: req.userId, queryFn: queryFn() });
    if (!r.bound) throw businessError(r.reason || '绑定失败', 400);
    res.json(r);
  })
);

export default router;
