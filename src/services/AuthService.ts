import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import type { CookieOptions } from 'express';
import type { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { UnauthenticatedError } from '../lib/errors.js';
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
