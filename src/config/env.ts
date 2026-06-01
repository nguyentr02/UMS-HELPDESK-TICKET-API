import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  AUTH_MODE: z.enum(['mock', 'sso']).default('mock'),

  HELPDESK_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Optional in Phase 1 (not consumed yet); tightened to required in the phases that use them.
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  JOB_SECRET: z.string().min(8).optional(),

  STORAGE_DRIVER: z.enum(['local', 'memory', 'blob', 's3']).default('local'),
  EVENT_PUBLISHER_DRIVER: z.enum(['logger', 'qstash']).default('logger'),
  QSTASH_TOKEN: z.string().min(1).optional(),
}).refine(
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
