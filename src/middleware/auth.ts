import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { UnauthenticatedError } from '../lib/errors.js';
import { parseSessionJwt, SESSION_COOKIE } from '../services/AuthService.js';

export type Role =
  | 'SV'
  | 'GV'
  | 'NV'
  | 'HelpdeskLead'
  | 'HelpdeskAgent'
  | 'DeptStaff'
  | 'Admin';

export interface SessionUser {
  id: string;
  role: Role;
  departmentId: string | null;
  /** Display name carried in the JWT for convenience (avoids a DB hit on every request). */
  displayName?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const VALID_ROLES: readonly Role[] = [
  'SV',
  'GV',
  'NV',
  'HelpdeskLead',
  'HelpdeskAgent',
  'DeptStaff',
  'Admin',
];

function isRole(value: string | undefined): value is Role {
  return value !== undefined && (VALID_ROLES as readonly string[]).includes(value);
}

function readMockUser(req: Request): SessionUser | null {
  const id = req.header('x-mock-user-id');
  const role = req.header('x-mock-role');
  const dept = req.header('x-mock-dept-id');
  const nameRaw = req.header('x-mock-display-name');
  if (!id || !isRole(role)) return null;
  let displayName: string | undefined;
  if (nameRaw) {
    try {
      displayName = decodeURIComponent(nameRaw);
    } catch {
      displayName = nameRaw;
    }
  }
  return { id, role, departmentId: dept ?? null, displayName };
}

function readCookieUser(req: Request): SessionUser | null {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    return parseSessionJwt(token);
  } catch {
    // Invalid/expired token = anonymous; `requireAuth` will 401 downstream if the route demands it.
    return null;
  }
}

/**
 * Attaches `req.user` if credentials are present. Does NOT enforce auth — that's `requireAuth`.
 *
 * - `jwt` mode (default, prod): the `ums_session` cookie is verified against `JWT_SECRET`.
 *   In non-prod the `X-Mock-*` headers are still honored as a fallback so the existing
 *   test suite and supertest-based integration tests keep working without a real login.
 * - `mock` mode: legacy header-only path (kept for the tests that opt into it explicitly).
 */
export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (env.AUTH_MODE === 'jwt') {
    const cookieUser = readCookieUser(req);
    if (cookieUser) {
      req.user = cookieUser;
    } else if (env.NODE_ENV !== 'production') {
      const mockUser = readMockUser(req);
      if (mockUser) req.user = mockUser;
    }
    return next();
  }

  // Legacy mock mode — every request reads X-Mock-* headers.
  const mockUser = readMockUser(req);
  if (mockUser) req.user = mockUser;
  next();
}

/**
 * Hard auth gate — `401 unauthenticated` if there's no session.
 *
 * For a **real (cookie) session** it also **re-validates against the DB on every
 * request**: a deactivated/deleted user is rejected immediately (not after the
 * 8 h token expires), and `req.user`'s role/department are refreshed from the DB
 * (the source of truth) so an admin's role/dept change takes effect at once
 * instead of lingering in the stale JWT. The mock-header path (dev/test only,
 * no cookie) is trusted as-is so it can inject arbitrary identities.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.user) return next(new UnauthenticatedError());

  const hasCookie = !!(req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!hasCookie) return next(); // mock-header session (non-prod) — trust as-is

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, role: true, departmentId: true, displayName: true, isActive: true },
    });
    if (!user || !user.isActive) {
      return next(new UnauthenticatedError('Phiên đăng nhập không còn hợp lệ'));
    }
    // Refresh from the DB source of truth (role/dept may have changed since the
    // token was issued).
    req.user = {
      id: user.id,
      role: user.role as Role,
      departmentId: user.departmentId,
      displayName: user.displayName ?? undefined,
    };
    return next();
  } catch (err) {
    return next(err as Error);
  }
}
