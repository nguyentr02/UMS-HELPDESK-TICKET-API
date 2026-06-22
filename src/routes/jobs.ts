import { Router } from 'express';
import { env } from '../config/env.js';
import { ok } from '../lib/envelope.js';
import { ForbiddenError } from '../lib/errors.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { runBlobSweep } from '../jobs/blob-sweep.js';
import { runDailyReminder } from '../jobs/daily-reminder.js';

export const jobsRouter = Router();

/** Shared bearer guard for Cron-invoked job endpoints (JOB_SECRET / CRON_SECRET). */
function assertJobSecret(req: { header(name: string): string | undefined }): void {
  const expected = env.JOB_SECRET;
  if (!expected) throw new ForbiddenError('JOB_SECRET not configured');
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== expected) throw new ForbiddenError('Invalid job secret');
}

/**
 * Vercel-Cron-invoked endpoint. Cron is configured in `vercel.json` to POST
 * here at `0 2 * * 1-5` UTC (09:00 ICT). Authenticated by a shared bearer
 * secret (`JOB_SECRET`); in prod on Vercel this is the `CRON_SECRET` env var
 * that the platform injects into the Authorization header.
 */
jobsRouter.post(
  '/jobs/daily-reminder',
  asyncHandler(async (req, res) => {
    assertJobSecret(req);
    const result = await runDailyReminder();
    res.json(ok(result, req.requestId));
  }),
);

/**
 * Vercel-Cron-invoked GC for orphaned Blob objects (uploaded to Blob but never
 * referenced by a ticket/comment that committed). Same `JOB_SECRET` bearer guard.
 */
jobsRouter.post(
  '/jobs/blob-sweep',
  asyncHandler(async (req, res) => {
    assertJobSecret(req);
    const result = await runBlobSweep();
    res.json(ok(result, req.requestId));
  }),
);
