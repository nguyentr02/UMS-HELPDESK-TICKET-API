import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ok } from '../lib/envelope.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { UserService } from '../services/UserService.js';
import { ALLOWED_EMAIL_DOMAINS_LABEL, isAllowedEmailDomain } from '../lib/email-domains.js';

const ROLES = ['SV', 'GV', 'NV', 'HelpdeskAgent', 'HelpdeskLead', 'DeptStaff', 'Admin'] as const;

// Display name = Unicode letters (so Vietnamese diacritics like ễ ă ị ư work)
// + combining marks + spaces only. No digits, no symbols. `\p{M}` covers
// decomposed diacritics; the `u` flag is required for `\p{...}`.
const NAME_REGEX = /^[\p{L}\p{M}\s]+$/u;
const NAME_ERROR = 'Họ tên chỉ được chứa chữ cái và khoảng trắng';

const ListQuery = z.object({
  role: z.enum(ROLES).optional(),
  departmentId: z.string().min(1).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// Empty string in `departmentId` / `password` is treated as "not provided" so
// the FE can submit a partial form without juggling undefined vs '' itself.
const CreateUserBody = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Email không hợp lệ')
    .max(200)
    .refine(isAllowedEmailDomain, `Email phải thuộc miền ${ALLOWED_EMAIL_DOMAINS_LABEL}`),
  displayName: z.string().trim().min(2, 'Tối thiểu 2 ký tự').max(200).regex(NAME_REGEX, NAME_ERROR),
  role: z.enum(ROLES),
  departmentId: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  password: z
    .string()
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional()
    .refine((v) => v == null || v.length >= 8, 'Mật khẩu tối thiểu 8 ký tự'),
});

// PATCH is a partial update — every field is optional. Email is intentionally
// absent (login identity stays in M1/IAM). `departmentId: null` clears the
// dept; omitting the key keeps the current value. Empty strings collapse to
// null for `departmentId` / `password` to match the create-body shape.
const UpdateUserBody = z.object({
  displayName: z
    .string()
    .trim()
    .min(2, 'Tối thiểu 2 ký tự')
    .max(200)
    .regex(NAME_REGEX, NAME_ERROR)
    .optional(),
  role: z.enum(ROLES).optional(),
  departmentId: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  password: z
    .string()
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional()
    .refine((v) => v == null || v.length >= 8, 'Mật khẩu tối thiểu 8 ký tự'),
});

function zodToFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    if (!fields[path]) fields[path] = issue.message;
  }
  return fields;
}

function parseListQuery(raw: unknown): z.infer<typeof ListQuery> {
  const parsed = ListQuery.safeParse(raw);
  if (!parsed.success) throw new ValidationError(zodToFields(parsed.error));
  return parsed.data;
}

function parseCreateBody(raw: unknown): z.infer<typeof CreateUserBody> {
  const parsed = CreateUserBody.safeParse(raw);
  if (!parsed.success) throw new ValidationError(zodToFields(parsed.error));
  return parsed.data;
}

function parseUpdateBody(raw: unknown): z.infer<typeof UpdateUserBody> {
  const parsed = UpdateUserBody.safeParse(raw);
  if (!parsed.success) throw new ValidationError(zodToFields(parsed.error));
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

/**
 * `POST /users` — Admin-only user creation. Hashes the optional password with
 * bcrypt; users created without a password can only sign in via Google SSO.
 * Returns `201` with the created `UserDTO` (no sensitive fields).
 *
 * NOTE: this endpoint deliberately steps outside the helpdesk's bounded
 * context (user lifecycle normally lives in M1 / IAM). Kept here for the
 * practice/demo flow per explicit product decision.
 */
usersRouter.post(
  '/users',
  requireAuth,
  requireRole('Admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = parseCreateBody(req.body);
    const created = await UserService.create({
      email: body.email,
      displayName: body.displayName,
      role: body.role,
      departmentId: body.departmentId ?? null,
      password: body.password ?? null,
    });
    res.status(201).json(ok(created, req.requestId));
  }),
);

/**
 * `PATCH /users/:id` — Admin-only partial update. Email is intentionally
 * immutable here; identity changes belong to M1/IAM. See `UserService.update`
 * for the validation matrix (404 / 422 cases).
 */
usersRouter.patch(
  '/users/:id',
  requireAuth,
  requireRole('Admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const body = parseUpdateBody(req.body);
    const updated = await UserService.update(req.params.id, {
      displayName: body.displayName,
      role: body.role,
      // `null` clears the dept; `undefined` keeps it. Forward verbatim.
      departmentId: body.departmentId,
      password: body.password,
    });
    res.json(ok(updated, req.requestId));
  }),
);

/**
 * `DELETE /users/:id` — Admin-only soft delete. Sets `isActive=false`. 409 if
 * the caller targets themselves (so the only Admin can't lock themselves out).
 * 404 when the id doesn't exist. Idempotent on already-inactive rows.
 */
usersRouter.delete(
  '/users/:id',
  requireAuth,
  requireRole('Admin'),
  asyncHandler(async (req: Request, res: Response) => {
    // req.user is guaranteed by requireAuth above.
    const callerId = req.user!.id;
    const result = await UserService.deactivate(req.params.id, callerId);
    res.json(ok(result, req.requestId));
  }),
);
