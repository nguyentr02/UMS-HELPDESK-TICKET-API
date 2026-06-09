import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ok } from '../lib/envelope.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { UserService } from '../services/UserService.js';

const ROLES = ['SV', 'GV', 'NV', 'HelpdeskAgent', 'HelpdeskLead', 'DeptStaff', 'Admin'] as const;

const ListQuery = z.object({
  role: z.enum(ROLES).optional(),
  departmentId: z.string().min(1).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function parseListQuery(raw: unknown): z.infer<typeof ListQuery> {
  const parsed = ListQuery.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '_';
      if (!fields[path]) fields[path] = issue.message;
    }
    throw new ValidationError(fields);
  }
  return parsed.data;
}

export const usersRouter = Router();

/**
 * `GET /users` — Admin-only paged directory of every persisted user.
 * Filters: `role`, `departmentId`, `search` (case-insensitive substring on
 * displayName OR email). Page size capped server-side at 100.
 */
usersRouter.get(
  '/users',
  requireAuth,
  requireRole('Admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = parseListQuery(req.query);
    const result = await UserService.list(q);
    res.json(ok(result, req.requestId));
  }),
);

/**
 * `GET /users/:id` — Admin-only single user lookup. 404 when the user
 * doesn't exist; never leaks `passwordHash` / `ssoSubject` / `googleId`.
 */
usersRouter.get(
  '/users/:id',
  requireAuth,
  requireRole('Admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const user = await UserService.getById(req.params.id);
    if (!user) throw new NotFoundError('Không tìm thấy người dùng');
    res.json(ok(user, req.requestId));
  }),
);
