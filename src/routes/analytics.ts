import { Router } from 'express';
import { ok } from '../lib/envelope';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { AnalyticsService } from '../services/AnalyticsService';

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
