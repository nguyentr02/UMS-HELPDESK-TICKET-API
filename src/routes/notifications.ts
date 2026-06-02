import { Router } from 'express';
import { ok } from '../lib/envelope.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { NotificationService } from '../services/NotificationService.js';

export const notificationsRouter = Router();

notificationsRouter.get(
  '/notifications',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await NotificationService.listForCaller(req.user!, {
      page: req.query.page !== undefined ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize !== undefined ? Number(req.query.pageSize) : undefined,
      unreadOnly: req.query.unreadOnly === 'true',
    });
    res.json(ok(result, req.requestId));
  }),
);

notificationsRouter.post(
  '/notifications/read-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await NotificationService.markAllRead(req.user!);
    res.json(ok(result, req.requestId));
  }),
);

notificationsRouter.post(
  '/notifications/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    const n = await NotificationService.markRead(req.params.id, req.user!);
    res.json(ok(n, req.requestId));
  }),
);
