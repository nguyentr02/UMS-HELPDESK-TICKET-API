import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { ok } from '../lib/envelope.js';
import { UnauthenticatedError, ValidationError } from '../lib/errors.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  GOOGLE_OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  googleStateCookieOptions,
  parseGoogleState,
  sanitizeNextPath,
  sessionCookieOptions,
  signGoogleState,
  signSessionJwt,
  upsertGoogleUser,
  verifyCredentials,
  verifyGoogleIdToken,
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

// ─── Google OAuth (Phase 12) ────────────────────────────────────────────────

const FE_ORIGIN_FALLBACK = 'http://localhost:3000';

/**
 * `GET /auth/google` — initiates the OAuth Authorization Code Flow. Generates
 * a signed `state` (carries `?next=` + a nonce, signed with JWT_SECRET), drops
 * it in a short-lived HttpOnly cookie scoped to the callback path, then 302s
 * the browser to Google's authorization URL.
 */
authRouter.get('/auth/google', (req: Request, res: Response) => {
  const next = sanitizeNextPath(typeof req.query.next === 'string' ? req.query.next : null);
  const nonce = randomBytes(16).toString('hex');
  const state = signGoogleState(next, nonce);
  res.cookie(GOOGLE_OAUTH_STATE_COOKIE, state, googleStateCookieOptions());
  res.redirect(302, buildGoogleAuthorizationUrl(state));
});

/**
 * `GET /auth/google/callback` — Google redirects here after the user grants
 * consent (or denies). Verifies the signed state (double-submit cookie),
 * exchanges the code for an ID token, verifies the ID token via Google's
 * JWKS, upserts the user (domain-allowlisted), and sets the session cookie
 * before redirecting back to the FE.
 *
 * Error pages: redirects back to `${FE_ORIGIN}/login?error=<code>` so the FE
 * can show a friendly message instead of leaking raw 401/403 JSON to the
 * browser address bar.
 */
authRouter.get(
  '/auth/google/callback',
  asyncHandler(async (req: Request, res: Response) => {
    const feOrigin = env.FE_ORIGIN ?? FE_ORIGIN_FALLBACK;
    const fail = (code: string) => {
      res.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, { ...googleStateCookieOptions(), maxAge: undefined });
      res.redirect(302, `${feOrigin}/login?error=${encodeURIComponent(code)}`);
    };

    // 1. Google may report an error directly (`?error=access_denied` etc.).
    if (typeof req.query.error === 'string') {
      return fail(req.query.error);
    }

    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const queryState = typeof req.query.state === 'string' ? req.query.state : null;
    const cookieState =
      (req as Request & { cookies?: Record<string, string> }).cookies?.[GOOGLE_OAUTH_STATE_COOKIE] ?? null;

    if (!code || !queryState || !cookieState || queryState !== cookieState) {
      return fail('invalid_state');
    }

    // 2. JWT-verify the state to extract `next` (and confirm we signed it).
    let nextPath = '/';
    try {
      const claims = parseGoogleState(queryState);
      nextPath = sanitizeNextPath(claims.next);
    } catch {
      return fail('invalid_state');
    }

    // 3. Exchange code → ID token → verified profile.
    let profile;
    try {
      const idToken = await exchangeGoogleCode(code);
      profile = await verifyGoogleIdToken(idToken);
    } catch (err) {
      return fail(err instanceof UnauthenticatedError ? 'google_verification_failed' : 'unknown_error');
    }

    // 4. Upsert + sign session.
    let user;
    try {
      user = await upsertGoogleUser(prisma, profile);
    } catch (err) {
      // Map the controlled errors to friendly FE codes.
      const errCode = (err as { code?: string }).code;
      const code =
        errCode === 'account_disabled'
          ? 'account_disabled'
          : errCode === 'forbidden'
            ? 'domain_not_allowed'
            : 'unknown_error';
      return fail(code);
    }

    res.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, { ...googleStateCookieOptions(), maxAge: undefined });
    res.cookie(SESSION_COOKIE, signSessionJwt(user), sessionCookieOptions());
    res.redirect(302, `${feOrigin}${nextPath}`);
  }),
);
