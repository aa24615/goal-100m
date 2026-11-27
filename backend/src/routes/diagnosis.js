// 诊断异议路由（RQ-226 拒绝归类 / M48 / I-2）

import express from 'express';
import pool from '../db.js';
import { authMiddleware, optionalAuth } from '../auth.js';
import { asyncHandler, businessError } from '../middleware.js';
import { identityOf, guestTokenFromRequest } from '../services/guestService.js';
import { buildCheckup } from '../services/checkupService.js';
import {
  DIAGNOSIS_CATALOG,
  extractDiagnosableItems,
  buildObjectionRecord,
  dedupeObjections,
  applyObjections,
  summarizeObjections,
  objectionOwnerClause,
  OBJECTION_SQL,
} from '../services/diagnosisObjectionService.js';

const router = express.Router();

/** 诊断项目录：前端据此渲染「不同意」按钮，不硬编码 key */
router.get('/diagnosis/catalog', (req, res) => {
  res.json({ catalog: DIAGNOSIS_CATALOG, maxReasonLen: 300 });
});

/**
 * 提交「不同意此诊断」留痕（可游客）。
 * 归属严格按 identityOf：注册用户写 user_id，游客写 guest_token，绝不混。
 */
router.post(
  '/diagnosis/objections',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const identity = identityOf({
      userId: req.userId,
      guestToken: guestTokenFromRequest(req),
    });
    if (identity.anonymous) throw businessError('需要登录或携带有效游客令牌', 401);
    const raw = req.body && typeof req.body === 'object' ? req.body : {};
    const ctx = { ...identity, now: new Date(), evidence: raw.evidence };
    const record = buildObjectionRecord(raw, ctx);
    if (!record) throw businessError('标记无效：未知诊断项 / 理由为空或超长 / 无有效身份', 400);

    const { rows } = await pool.query(
      `${OBJECTION_SQL.insert} ON CONFLICT ${OBJECTION_SQL.unique} DO UPDATE SET
         reason = EXCLUDED.reason,
         evidence_text = EXCLUDED.evidence_text,
         sample_size = EXCLUDED.sample_size,
         created_at = now()
       RETURNING *`,
      [
        record.userId,
        record.guestToken,
        record.sessionId,
        record.diagnosisKey,
        record.reason,
        record.evidenceText,
        record.sampleSize,
      ]
    );
    res.json({ ok: true, objection: rows[0] });
  })
);

/**
 * 查询我的异议留痕（按归属隔离），并把留痕叠加到诊断视图上。
 * 可选 ?checkup=1 时，从 body.sessionId 取会话重新构建体检单再叠加——
 * 若会话数据不可得，仍返回留痕本身，不让「记录可查」依赖体检单是否还在。
 */
router.get(
  '/diagnosis/objections',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const identity = identityOf({
      userId: req.userId,
      guestToken: guestTokenFromRequest(req),
    });
    const where = objectionOwnerClause(identity, 1);
    if (!where.ownerKey) throw businessError('需要登录或携带有效游客令牌', 401);
    const { rows } = await pool.query(
      `SELECT * FROM diagnosis_objections WHERE ${where.sql} ORDER BY created_at DESC`,
      where.params
    );
    const objections = dedupeObjections(rows);
    const summary = summarizeObjections(objections);
    res.json({ ok: true, objections, summary });
  })
);

export default router;
