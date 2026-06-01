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
