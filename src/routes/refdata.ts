import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { ok } from '../lib/envelope.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * FE-driven reference-data routes. The Forward dropdown and the
 * Assign dialog need the lists below; the rest of the API only references
 * the entities by id, so these were added for client UX rather than
 * domain modelling.
 */
export const refDataRouter = Router();

refDataRouter.get(
  '/agents',
  requireAuth,
  asyncHandler(async (req, res) => {
    const agents = await prisma.user.findMany({
      where: { role: 'HelpdeskAgent', isActive: true },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });
    res.json(ok(agents, req.requestId));
  }),
);

refDataRouter.get(
  '/departments',
  requireAuth,
  asyncHandler(async (req, res) => {
    const departments = await prisma.department.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(ok(departments, req.requestId));
  }),
);
