import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors.js';
import type { Role } from './auth.js';

/** Allow only callers whose role is in the given set. */
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new UnauthenticatedError());
    if (!allowed.includes(req.user.role)) return next(new ForbiddenError());
    next();
  };
}
