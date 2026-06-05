import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ok } from '../lib/envelope.js';
import { ValidationError } from '../lib/errors.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  signSessionJwt,
  verifyCredentials,
} from '../services/AuthService.js';
import { requireAuth } from '../middleware/auth.js';
import { loginRateLimiter } from '../middleware/rateLimitLogin.js';

const LoginBody = z.object({
  email: z.string().min(1, 'Vui lòng nhập email').email('Email không hợp lệ'),
  password: z.string().min(1, 'Vui lòng nhập mật khẩu'),
});

function parseLoginBody(body: unknown): z.infer<typeof LoginBody> {
  const parsed = LoginBody.safeParse(body);
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

export const authRouter = Router();

/**
 * `POST /auth/login` — verify email+password, set session cookie, return user.
 * Rate-limited (FP §I); validation errors → 422; auth failures → opaque 401.
 */
authRouter.post(
  '/auth/login',
  loginRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = parseLoginBody(req.body);
    const user = await verifyCredentials(prisma, email, password);
    const token = signSessionJwt(user);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    res.json(ok({ user }, req.requestId));
  }),
);

/**
 * `POST /auth/logout` — clear the session cookie. Idempotent (200 even if no cookie).
 */
authRouter.post('/auth/logout', (req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
  res.json(ok({}, req.requestId));
});

/**
 * `GET /auth/me` — return the caller's session user (401 when no cookie / invalid).
 */
authRouter.get('/auth/me', requireAuth, (req: Request, res: Response) => {
  res.json(ok({ user: req.user }, req.requestId));
});
