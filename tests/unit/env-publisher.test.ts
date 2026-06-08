import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';

/** Build a minimal env source — only the fields the schema cares about. */
function envFrom(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://x:y@localhost:5433/x',
    JOB_SECRET: 'sufficiently-long-secret',
    HELPDESK_ENABLED: 'true',
    LOG_LEVEL: 'silent',
    // jwt-mode requires several fields; supply synthetic test-only values so
    // the publisher tests stay focused on EVENT_PUBLISHER_DRIVER without
    // dragging the auth + OAuth schema in. Real secrets live in .env (local)
    // and Vercel env vars (prod) — never in test source.
    AUTH_MODE: 'jwt',
    JWT_SECRET: 'test-secret-at-least-32-characters-long',
    CORS_ORIGIN: 'http://localhost:3000',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    GOOGLE_CALLBACK_URL: 'http://localhost:4000/auth/google/callback',
    FE_ORIGIN: 'http://localhost:3000',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('BE-S9-X1 — env validation', () => {
  it('default (logger) driver: no QSTASH_TOKEN required', () => {
    expect(() => loadEnv(envFrom({}))).not.toThrow();
  });

  it('EVENT_PUBLISHER_DRIVER=qstash WITHOUT QSTASH_TOKEN → loadEnv throws with a clear message', () => {
    expect(() =>
      loadEnv(envFrom({ EVENT_PUBLISHER_DRIVER: 'qstash', QSTASH_TOKEN: undefined })),
    ).toThrow(/QSTASH_TOKEN/);
  });

  it('EVENT_PUBLISHER_DRIVER=qstash WITH QSTASH_TOKEN → loadEnv passes', () => {
    expect(() =>
      loadEnv(envFrom({ EVENT_PUBLISHER_DRIVER: 'qstash', QSTASH_TOKEN: 'tk_test' })),
    ).not.toThrow();
  });
});
