import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../lib/envelope.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { zodValidate } from '../middleware/zodValidate.js';
import { emitBroadcast } from '../lib/realtime.js';
import { CategoryService } from '../services/CategoryService.js';

const createBody = z.object({
  name: z.string().trim().min(2, 'Tên danh mục tối thiểu 2 ký tự').max(120),
});

const updateBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  isActive: z.boolean().optional(),
});

export const categoriesRouter = Router();

// List — any authenticated user
categoriesRouter.get(
  '/categories',
  requireAuth,
  asyncHandler(async (req, res) => {
    const cats = await CategoryService.list();
    res.json(ok(cats, req.requestId));
  }),
);

// Admin-only CRUD
categoriesRouter.post(
  '/categories',
  requireAuth,
  requireRole('Admin'),
  zodValidate(createBody),
  asyncHandler(async (req, res) => {
    const cat = await CategoryService.create(req.body);
    emitBroadcast('categories:changed');
    res.status(201).json(ok(cat, req.requestId));
  }),
);

categoriesRouter.patch(
  '/categories/:id',
  requireAuth,
  requireRole('Admin'),
  zodValidate(updateBody),
  asyncHandler(async (req, res) => {
    const cat = await CategoryService.update(req.params.id, req.body);
    emitBroadcast('categories:changed');
    res.json(ok(cat, req.requestId));
  }),
);

categoriesRouter.delete(
  '/categories/:id',
  requireAuth,
  requireRole('Admin'),
  asyncHandler(async (req, res) => {
    await CategoryService.remove(req.params.id);
    emitBroadcast('categories:changed');
    res.json(ok({ id: req.params.id }, req.requestId));
  }),
);
