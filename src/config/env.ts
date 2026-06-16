import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  // 'jwt' (default) = HttpOnly Secure SameSite=None cookie verified against JWT_SECRET.
  // 'mock' = legacy X-Mock-* header path, only meaningful in dev/test; production must use 'jwt'.
  AUTH_MODE: z.enum(['mock', 'jwt']).default('jwt'),

  // Required in jwt mode; min 32 chars so HS256 has enough entropy.
  JWT_SECRET: z.string().min(32).optional(),

  // Comma-separated list of allowed origins for cross-origin cookie auth (FE → BE).
  // Required in jwt mode. Example: "https://umshelpdesk.vercel.app,http://localhost:3000"
  CORS_ORIGIN: z.string().min(1).optional(),

  // Google OAuth (Phase 12). Required in jwt mode — `/auth/google` routes
  // construct/verify against these. CALLBACK_URL must match the URL
  // allowlisted in Google Cloud Console.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_CALLBACK_URL: z.string().url().optional(),

  // Where the BE redirects the browser after the Google callback succeeds.
  // Required in jwt mode. Example: "https://umshelpdesk.vercel.app"
  FE_ORIGIN: z.string().url().optional(),

  HELPDESK_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Optional in Phase 1 (not consumed yet); tightened to required in the phases that use them.
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  JOB_SECRET: z.string().min(8).optional(),

  // Realtime (Socket.IO) push for the notification bell. Optional — when either
  // is unset, emits are silently skipped and the FE falls back to its 30s poll.
  // EMIT_SECRET must match the realtime server's value; URL is its base origin
  // (e.g. "https://ums-helpdesk-realtime.onrender.com"), POST /emit is appended.
  REALTIME_EMIT_URL: z.string().url().optional(),
  REALTIME_EMIT_SECRET: z.string().min(1).optional(),
  // Secret for signing the short-lived socket-handshake token. Optional — falls
  // back to JWT_SECRET. Set a dedicated value (matching the realtime server's
  // REALTIME_JWT_SECRET) so the socket service never holds the session key.
  REALTIME_JWT_SECRET: z.string().min(1).optional(),

  STORAGE_DRIVER: z.enum(['local', 'memory', 'blob', 's3']).default('local'),
  EVENT_PUBLISHER_DRIVER: z.enum(['logger', 'qstash']).default('logger'),
  QSTASH_TOKEN: z.string().min(1).optional(),
}).refine(
  // jwt mode needs the secret. Mock mode (dev/test only) doesn't.
  (data) => data.AUTH_MODE !== 'jwt' || !!data.JWT_SECRET,
  { message: 'JWT_SECRET is required when AUTH_MODE=jwt', path: ['JWT_SECRET'] },
).refine(
  (data) => data.AUTH_MODE !== 'jwt' || !!data.CORS_ORIGIN,
  { message: 'CORS_ORIGIN is required when AUTH_MODE=jwt', path: ['CORS_ORIGIN'] },
).refine(
  (data) => data.AUTH_MODE !== 'jwt' || !!data.GOOGLE_CLIENT_ID,
  { message: 'GOOGLE_CLIENT_ID is required when AUTH_MODE=jwt', path: ['GOOGLE_CLIENT_ID'] },
).refine(
  (data) => data.AUTH_MODE !== 'jwt' || !!data.GOOGLE_CLIENT_SECRET,
  { message: 'GOOGLE_CLIENT_SECRET is required when AUTH_MODE=jwt', path: ['GOOGLE_CLIENT_SECRET'] },
).refine(
  (data) => data.AUTH_MODE !== 'jwt' || !!data.GOOGLE_CALLBACK_URL,
  { message: 'GOOGLE_CALLBACK_URL is required when AUTH_MODE=jwt', path: ['GOOGLE_CALLBACK_URL'] },
).refine(
  (data) => data.AUTH_MODE !== 'jwt' || !!data.FE_ORIGIN,
  { message: 'FE_ORIGIN is required when AUTH_MODE=jwt', path: ['FE_ORIGIN'] },
).refine(
  // Boot-time guard (FP §K): if the prod event driver is selected we MUST have
  // a token, otherwise the first publish would 500. Fail fast at startup.
  (data) => data.EVENT_PUBLISHER_DRIVER !== 'qstash' || !!data.QSTASH_TOKEN,
  {
    message: 'QSTASH_TOKEN is required when EVENT_PUBLISHER_DRIVER=qstash',
    path: ['QSTASH_TOKEN'],
  },
);

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}

/** Cached env for the running process. Tests can call loadEnv(custom) for isolation. */
export const env: Env = loadEnv();
