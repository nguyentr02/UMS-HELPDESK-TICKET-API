import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import type { CookieOptions } from 'express';
import type { PrismaClient } from '@prisma/client';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { DisabledAccountError, ForbiddenError, UnauthenticatedError } from '../lib/errors.js';
import {
  ALLOWED_EMAIL_DOMAINS_LABEL,
  emailDomain,
  isAllowedEmailDomain,
} from '../lib/email-domains.js';
import type { Role, SessionUser } from '../middleware/auth.js';

/** Name of the auth cookie carried in every authenticated request. */
export const SESSION_COOKIE = 'ums_session';

/** 8 hours — matches FP §I; no refresh. */
const SESSION_TTL_SECONDS = 8 * 60 * 60;

interface JwtClaims extends JwtPayload {
  sub: string;
  role: Role;
  departmentId: string | null;
  displayName?: string;
}

function requireSecret(): string {
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured — auth disabled');
  }
  return env.JWT_SECRET;
}

/** Look up a user by email and verify the bcrypt password. Throws `UnauthenticatedError` on any mismatch. */
export async function verifyCredentials(
  prisma: PrismaClient,
  email: string,
  password: string,
): Promise<SessionUser> {
  // Tolerate the FE not lower-casing the email; `.toLowerCase()` here keeps the
  // 401 path opaque (same response shape whether the email or the password is wrong).
  const normalized = email.trim().toLowerCase();
  const user = await prisma.user.findFirst({
    where: { email: normalized, isActive: true },
    select: {
      id: true,
      role: true,
      departmentId: true,
      displayName: true,
      passwordHash: true,
    },
  });
  if (!user || !user.passwordHash) throw new UnauthenticatedError('Sai email hoặc mật khẩu');

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new UnauthenticatedError('Sai email hoặc mật khẩu');

  return {
    id: user.id,
    role: user.role as Role,
    departmentId: user.departmentId,
    displayName: user.displayName,
  };
}

/** Sign an 8 h HS256 JWT with the session user's identity + role. */
export function signSessionJwt(user: SessionUser): string {
  const payload: JwtClaims = {
    sub: user.id,
    role: user.role,
    departmentId: user.departmentId ?? null,
    displayName: user.displayName,
  };
  const options: SignOptions = { algorithm: 'HS256', expiresIn: SESSION_TTL_SECONDS };
  return jwt.sign(payload, requireSecret(), options);
}

/** Short-lived token the FE hands to the Socket.IO server to authenticate its
 *  connection. The realtime server verifies it with the SAME JWT_SECRET (HS256)
 *  and reads `sub` to scope the socket to that user's room. */
export const REALTIME_TOKEN_TTL_SECONDS = 60;

/** Sign a 60 s HS256 JWT carrying only the user id, for the realtime socket handshake. */
export function signRealtimeToken(userId: string): string {
  return jwt.sign({ sub: userId }, requireSecret(), {
    algorithm: 'HS256',
    expiresIn: REALTIME_TOKEN_TTL_SECONDS,
  });
}

/** Verify a JWT and return the carried session user. Throws `UnauthenticatedError` on any failure. */
export function parseSessionJwt(token: string): SessionUser {
  try {
    const decoded = jwt.verify(token, requireSecret(), { algorithms: ['HS256'] }) as JwtClaims;
    return {
      id: decoded.sub,
      role: decoded.role,
      departmentId: decoded.departmentId,
      displayName: decoded.displayName,
    };
  } catch {
    throw new UnauthenticatedError('Phiên đăng nhập đã hết hạn');
  }
}

/**
 * Cookie options for the session cookie.
 *
 * Production: `HttpOnly Secure SameSite=None`, host-only (no `domain`) — FE on
 * `umshelpdesk.vercel.app` calls BE on `ums-helpdesk-api.vercel.app`; `.vercel.app`
 * is on the Public Suffix List so a parent-domain cookie is impossible. The
 * browser sends the cookie because of `SameSite=None` + `Secure`.
 *
 * Dev: `SameSite=Lax`, `Secure=false` so the cookie works on `http://localhost`.
 */
export function sessionCookieOptions(): CookieOptions {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}

// ─── Google OAuth (Phase 12) ────────────────────────────────────────────────

/** Cookie that holds the signed OAuth `state` between `/auth/google` and the callback. */
export const GOOGLE_OAUTH_STATE_COOKIE = 'google_oauth_state';

/** 10 min — generous enough for the user to complete Google sign-in, short enough to keep CSRF window tight. */
export const GOOGLE_STATE_TTL_SECONDS = 10 * 60;

interface GoogleStateClaims extends JwtPayload {
  /** Sanitized `?next=` path the FE wants to land on after the callback. */
  next: string;
  /** Random nonce — purely to make the JWT unique per request so cookies don't collide. */
  nonce: string;
}

export interface VerifiedGoogleProfile {
  /** Google `sub` claim — stable per user across Google product changes. */
  googleId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Lazy-built `OAuth2Client`. Cached per-process so the JWKS that
 * `verifyIdToken` fetches gets reused across calls in the same warm Vercel
 * function instance.
 */
let oauthClient: OAuth2Client | null = null;
function getOAuthClient(): OAuth2Client {
  if (!oauthClient) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_CALLBACK_URL) {
      throw new Error('Google OAuth env (GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL) is not configured');
    }
    oauthClient = new OAuth2Client({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_CALLBACK_URL,
    });
  }
  return oauthClient;
}

/**
 * Sign the OAuth `state` value — embedded both in the redirect URL AND in a
 * short-lived cookie (double-submit pattern). The callback rejects unless
 * cookie === query AND `jwt.verify` succeeds.
 */
export function signGoogleState(next: string, nonce: string): string {
  const claims: GoogleStateClaims = { next, nonce };
  return jwt.sign(claims, requireSecret(), {
    algorithm: 'HS256',
    expiresIn: GOOGLE_STATE_TTL_SECONDS,
  });
}

/** Verify the signed `state` and return the embedded claims. Throws `UnauthenticatedError` on any failure. */
export function parseGoogleState(token: string): GoogleStateClaims {
  try {
    return jwt.verify(token, requireSecret(), { algorithms: ['HS256'] }) as GoogleStateClaims;
  } catch {
    throw new UnauthenticatedError('Phiên đăng nhập Google đã hết hạn');
  }
}

/**
 * Sanitize the `?next=` path so it can't be used as an open-redirect. Must
 * start with a single `/`, no scheme, no `//` (protocol-relative). Anything
 * else falls back to `/`.
 */
export function sanitizeNextPath(input: string | undefined | null): string {
  if (!input) return '/';
  // Reject scheme:// (e.g., `https://evil.com`) and protocol-relative `//evil.com`.
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) || input.startsWith('//')) return '/';
  if (!input.startsWith('/')) return '/';
  return input;
}

/**
 * Verify a Google ID token using the Google JWKS, return the profile fields
 * we care about. Rejects unverified emails (Google may issue tokens for
 * pending email-verification flows; we don't trust them).
 */
export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleProfile> {
  const client = getOAuthClient();
  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
  } catch {
    throw new UnauthenticatedError('Xác minh Google ID token thất bại');
  }
  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw new UnauthenticatedError('Google ID token thiếu thông tin bắt buộc');
  }
  if (payload.email_verified !== true) {
    throw new UnauthenticatedError('Email Google chưa được xác minh');
  }
  return {
    googleId: payload.sub,
    email: payload.email.trim().toLowerCase(),
    displayName: payload.name?.trim() || payload.email,
    avatarUrl: payload.picture ?? null,
  };
}

/**
 * Upsert path for Google sign-ins. Three branches:
 *   1. Found by `googleId` → refresh displayName + avatarUrl, return SessionUser.
 *   2. Not by googleId but email matches an existing row → link (set googleId),
 *      preserve role + departmentId + history.
 *   3. No match → create new with `role: 'SV'`, `departmentId: null`.
 *
 * Domain allowlist is enforced first — `@ums.edu.vn` / `@dau.edu.vn` only.
 * Anything else throws `ForbiddenError`.
 */
export async function upsertGoogleUser(
  prisma: PrismaClient,
  profile: VerifiedGoogleProfile,
): Promise<SessionUser> {
  if (!isAllowedEmailDomain(profile.email)) {
    throw new ForbiddenError(
      `Tài khoản Google thuộc miền @${emailDomain(profile.email)} không được phép. Vui lòng dùng email ${ALLOWED_EMAIL_DOMAINS_LABEL}.`,
    );
  }

  // 1. By googleId — returning user.
  const byGoogleId = await prisma.user.findUnique({ where: { googleId: profile.googleId } });
  if (byGoogleId) {
    // A deactivated (soft-deleted) account must not be able to sign back in via
    // SSO — that would defeat the Admin's delete. Re-enabling is an Admin action
    // (re-create the email → revive) or an M1/IAM action, never a self-service
    // re-login. Mirrors the `isActive: true` filter on the password path.
    if (!byGoogleId.isActive) throw new DisabledAccountError();
    const refreshed = await prisma.user.update({
      where: { id: byGoogleId.id },
      data: {
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      },
    });
    return {
      id: refreshed.id,
      role: refreshed.role as Role,
      departmentId: refreshed.departmentId,
      displayName: refreshed.displayName,
    };
  }

  // 2. By email — link the existing row to this Google account.
  const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
  if (byEmail) {
    // Same guard as branch 1: a deactivated row must not be revived by a login.
    if (!byEmail.isActive) throw new DisabledAccountError();
    const linked = await prisma.user.update({
      where: { id: byEmail.id },
      data: {
        googleId: profile.googleId,
        avatarUrl: profile.avatarUrl,
        // displayName stays as the operator-set one; Google's name doesn't override it.
      },
    });
    return {
      id: linked.id,
      role: linked.role as Role,
      departmentId: linked.departmentId,
      displayName: linked.displayName,
    };
  }

  // 3. New user — first time signing in with Google AND no email match. Create with SV role.
  const created = await prisma.user.create({
    data: {
      ssoSubject: `google:${profile.googleId}`,
      email: profile.email,
      googleId: profile.googleId,
      avatarUrl: profile.avatarUrl,
      displayName: profile.displayName,
      role: 'SV',
      departmentId: null,
    },
  });
  return {
    id: created.id,
    role: created.role as Role,
    departmentId: created.departmentId,
    displayName: created.displayName,
  };
}

/**
 * Build the Google authorization URL for `?response_type=code` flow with the
 * given signed `state`. We request the minimum scopes (`openid email profile`)
 * since we only need identity, not any Google API access.
 */
export function buildGoogleAuthorizationUrl(state: string): string {
  return getOAuthClient().generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
  });
}

/**
 * Exchange the authorization `code` returned by Google for tokens. Returns the
 * ID token string — the caller passes it to `verifyGoogleIdToken`.
 */
export async function exchangeGoogleCode(code: string): Promise<string> {
  const client = getOAuthClient();
  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) {
      throw new UnauthenticatedError('Google không trả về ID token');
    }
    return tokens.id_token;
  } catch (err) {
    if (err instanceof UnauthenticatedError) throw err;
    throw new UnauthenticatedError('Trao đổi mã Google thất bại');
  }
}

/** Cookie options for the short-lived OAuth state cookie. Same-site Lax + Secure-in-prod. */
export function googleStateCookieOptions(): CookieOptions {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    // Lax permits the cookie on the top-level GET navigation Google sends us
    // back on. We don't need None here — the callback IS a top-level redirect.
    sameSite: 'lax',
    // Path '/' (not the callback path): when SSO runs through the FE same-origin
    // proxy, the browser-visible callback is `/api/v1/auth/google/callback`, so a
    // cookie scoped to `/auth/google/callback` would never be sent → invalid_state.
    // The JWT-signed double-submit still provides CSRF protection regardless of path.
    path: '/',
    maxAge: GOOGLE_STATE_TTL_SECONDS * 1000,
  };
}
