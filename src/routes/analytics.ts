import { Router } from 'express';
import { ok } from '../lib/envelope.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { AnalyticsService } from '../services/AnalyticsService.js';

export const analyticsRouter = Router();

analyticsRouter.get(
  '/analytics/summary',
  requireAuth,
  requireRole('HelpdeskLead', 'HelpdeskAgent', 'Admin'),
  asyncHandler(async (req, res) => {
    const summary = await AnalyticsService.summary();
    res.json(ok(summary, req.requestId));
  }),
);
