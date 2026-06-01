import type { Express } from 'express';
import { buildApp } from '@/app';

/** Fresh Express instance per test suite — no shared state between suites. */
export function createTestApp(): Express {
  return buildApp();
}
