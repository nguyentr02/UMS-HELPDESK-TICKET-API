import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { UnauthenticatedError } from '../lib/errors';

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
  if (!id || !isRole(role)) return null;
  return { id, role, departmentId: dept ?? null };
}

/** Attaches `req.user` if credentials are present. Does NOT enforce auth — that's `requireAuth`. */
export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (env.AUTH_MODE === 'mock') {
    const user = readMockUser(req);
    if (user) req.user = user;
  } else {
    // SSO mode: the passport strategy will populate req.user via session/JWT.
    // Wired at deploy time; intentionally a no-op here.
  }
  next();
}

/** Hard auth gate — throws `401 unauthenticated` if `req.user` isn't set. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new UnauthenticatedError());
  next();
}
