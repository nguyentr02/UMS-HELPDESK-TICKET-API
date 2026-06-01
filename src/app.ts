import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { fail, ok } from './lib/envelope';
import { NotFoundError } from './lib/errors';
import { requestIdMiddleware } from './middleware/requestId';
import { authMiddleware, requireAuth } from './middleware/auth';
import { requireRole } from './middleware/rbac';
import { errorMiddleware } from './middleware/error';
import { healthzRouter } from './routes/healthz';
import { docsRouter } from './routes/docs';
import { categoriesRouter } from './routes/categories';
import { routingRulesRouter } from './routes/routingRules';
import { ticketsRouter } from './routes/tickets';
import { notificationsRouter } from './routes/notifications';
import { jobsRouter } from './routes/jobs';
import { analyticsRouter } from './routes/analytics';

/**
 * Build the Express app. Exported as a factory so supertest tests can spin up
 * a fresh instance per suite and so the Vercel handler can default-export the
 * built app (no `app.listen()` in prod).
 */
export function buildApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  // Middleware chain (FP §F): requestId → log → cors → helmet → body parser
  // → healthz (always-on) → kill-switch → auth → routes → 404 → error.
  app.use(requestIdMiddleware);
  app.use(pinoHttp({ logger, customLogLevel: (_req, res) => (res.statusCode >= 500 ? 'error' : 'info') }));
  app.use(cors());
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  // Healthz is public AND unaffected by the kill-switch — monitoring stays alive.
  app.use(healthzRouter);

  // Swagger UI + /openapi.json — public AND outside the kill-switch so developers
  // can always reach the docs (ISO §8.3).
  app.use(docsRouter);

  // Kill-switch (FP §L) — disables every other route without a redeploy.
  app.use((req, res, next) => {
    if (env.HELPDESK_ENABLED) return next();
    res
      .status(503)
      .json(fail({ code: 'helpdesk_disabled', message: 'Module Helpdesk tạm dừng' }, req.requestId));
  });

  // Soft-attach req.user if SSO credentials are present.
  app.use(authMiddleware);

  // Diagnostic routes — exercise the middleware chain end-to-end and let the
  // BE-S1 integration tests cover auth/RBAC/error wiring before real routes
  // arrive. They only echo the caller's auth context.
  app.get('/_debug/auth-required', requireAuth, (req, res) => {
    res.json(ok({ user: req.user }, req.requestId));
  });

  app.get('/_debug/admin-only', requireAuth, requireRole('Admin'), (req, res) => {
    res.json(ok({ ok: true }, req.requestId));
  });

  app.get('/_debug/throw', (_req, _res, next) => {
    next(new Error('intentional'));
  });

  // Real routers (Phase 3+)
  app.use(categoriesRouter);
  app.use(routingRulesRouter);
  app.use(ticketsRouter);
  app.use(notificationsRouter);
  app.use(jobsRouter);
  app.use(analyticsRouter);

  // 404 fallback for unknown endpoints
  app.use((_req, _res, next) => next(new NotFoundError('Endpoint không tồn tại')));

  // Final error shaper (must be last)
  app.use(errorMiddleware);

  return app;
}

// Default export so the Vercel `@vercel/node` runtime can use the app directly.
export default buildApp();
