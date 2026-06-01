import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../lib/envelope';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { zodValidate } from '../middleware/zodValidate';
import { CategoryService } from '../services/CategoryService';

const createBody = z.object({
  name: z.string().trim().min(2, 'Tên danh mục tối thiểu 2 ký tự').max(120),
  parentId: z.string().min(1).nullable().optional(),
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
    res.json(ok(cat, req.requestId));
  }),
);

categoriesRouter.delete(
  '/categories/:id',
  requireAuth,
  requireRole('Admin'),
  asyncHandler(async (req, res) => {
    await CategoryService.remove(req.params.id);
    res.json(ok({ id: req.params.id }, req.requestId));
  }),
);
