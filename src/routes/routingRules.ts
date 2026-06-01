import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../lib/envelope.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { zodValidate } from '../middleware/zodValidate.js';
import { RoutingService } from '../services/RoutingService.js';

const createBody = z.object({
  categoryId: z.string().min(1),
  departmentId: z.string().min(1),
  isDefault: z.boolean().optional(),
});

const updateBody = z.object({
  departmentId: z.string().min(1).optional(),
  isDefault: z.boolean().optional(),
});

export const routingRulesRouter = Router();

// List — any authenticated user
routingRulesRouter.get(
  '/routing-rules',
  requireAuth,
  asyncHandler(async (req, res) => {
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined;
    const rules = await RoutingService.list({ categoryId });
    res.json(ok(rules, req.requestId));
  }),
);

// Admin-only CRUD
routingRulesRouter.post(
  '/routing-rules',
  requireAuth,
  requireRole('Admin'),
  zodValidate(createBody),
  asyncHandler(async (req, res) => {
    const rule = await RoutingService.create(req.body);
    res.status(201).json(ok(rule, req.requestId));
  }),
);

routingRulesRouter.patch(
  '/routing-rules/:id',
  requireAuth,
  requireRole('Admin'),
  zodValidate(updateBody),
  asyncHandler(async (req, res) => {
    const rule = await RoutingService.update(req.params.id, req.body);
    res.json(ok(rule, req.requestId));
  }),
);

routingRulesRouter.delete(
  '/routing-rules/:id',
  requireAuth,
  requireRole('Admin'),
  asyncHandler(async (req, res) => {
    await RoutingService.remove(req.params.id);
    res.json(ok({ id: req.params.id }, req.requestId));
  }),
);
