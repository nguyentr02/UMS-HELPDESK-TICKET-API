import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { fail, ok } from './lib/envelope.js';
import { NotFoundError } from './lib/errors.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { authMiddleware, requireAuth } from './middleware/auth.js';
import { requireRole } from './middleware/rbac.js';
import { errorMiddleware } from './middleware/error.js';
import { healthzRouter } from './routes/healthz.js';
import { docsRouter } from './routes/docs.js';
import { authRouter } from './routes/auth.js';
import { categoriesRouter } from './routes/categories.js';
import { ticketsRouter } from './routes/tickets.js';
import { notificationsRouter } from './routes/notifications.js';
import { jobsRouter } from './routes/jobs.js';
import { analyticsRouter } from './routes/analytics.js';
import { refDataRouter } from './routes/refdata.js';
import { attachmentsUploadRouter } from './routes/attachments-upload.js';

/**
 * Build the Express app. Exported as a factory so supertest tests can spin up
 * a fresh instance per suite and so the Vercel handler can default-export the
 * built app (no `app.listen()` in prod).
 */
export function buildApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  // Middleware chain (FP §F): requestId → log → cors → helmet → body parser →
  // cookie-parser → healthz (always-on) → kill-switch → auth → routes → 404 → error.
  app.use(requestIdMiddleware);
  app.use(pinoHttp({ logger, customLogLevel: (_req, res) => (res.statusCode >= 500 ? 'error' : 'info') }));

  // Cross-origin cookie auth needs `credentials: true` + an explicit origin allow-list.
  // CORS_ORIGIN is comma-separated (e.g. "https://umshelpdesk.vercel.app,http://localhost:3000").
  // When unset (legacy mock-mode dev), fall back to permissive same-origin behavior.
  const corsOrigins = env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(
    cors(
      corsOrigins && corsOrigins.length > 0
        ? { origin: corsOrigins, credentials: true }
        : {},
    ),
  );
  // Helmet with CSP that allows the Swagger UI CDN (jsdelivr) for /docs.
  // JSON endpoints don't load scripts/styles so the relaxations are inert
  // outside the docs page.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
          'style-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
          'img-src': ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
          'font-src': ["'self'", 'https://cdn.jsdelivr.net'],
          'connect-src': ["'self'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

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

  // Auth endpoints — login is public (rate-limited inside the router); logout
  // is idempotent; /auth/me is gated by requireAuth inside the router.
  app.use(authRouter);

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
  app.use(ticketsRouter);
  app.use(notificationsRouter);
  app.use(jobsRouter);
  app.use(analyticsRouter);
  app.use(refDataRouter);
  app.use(attachmentsUploadRouter);

  // 404 fallback for unknown endpoints
  app.use((_req, _res, next) => next(new NotFoundError('Endpoint không tồn tại')));

  // Final error shaper (must be last)
  app.use(errorMiddleware);

  return app;
}

// Default export so the Vercel `@vercel/node` runtime can use the app directly.
export default buildApp();
