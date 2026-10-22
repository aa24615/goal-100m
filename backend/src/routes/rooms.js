// 房间赛路由（RQ-20 ~ RQ-22）

import express from 'express';
import { authMiddleware } from '../auth.js';
import { asyncHandler, businessError } from '../middleware.js';
import { createRoom, joinRoom, roomDetail, myRooms, closeRoom } from '../services/roomService.js';

const router = express.Router();

// RQ-20 创建房间赛
router.post(
  '/rooms',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { name, duration } = req.body || {};
    if (!name || String(name).trim().length === 0) throw businessError('请填写房间名称', 400);
    res.json(await createRoom({ userId: req.userId, name, duration }));
  })
);

// RQ-20 邀请码加入
router.post(
  '/rooms/join',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { code } = req.body || {};
    if (!code) throw businessError('请输入邀请码', 400);
    res.json(await joinRoom({ userId: req.userId, code }));
  })
);

// 我参与的房间
router.get(
  '/rooms',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await myRooms(req.userId));
  })
);

// RQ-21 房间实时排名
router.get(
  '/rooms/:id',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await roomDetail(Number(req.params.id), req.userId));
  })
);

// RQ-22 结束并生成战绩卡
router.post(
  '/rooms/:id/close',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await closeRoom({ roomId: Number(req.params.id), userId: req.userId }));
  })
);

export default router;
