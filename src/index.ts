import { buildApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';

// On Vercel the platform invokes the default export from `app.ts` directly.
// Locally we bind an HTTP listener.
if (!process.env.VERCEL) {
  const app = buildApp();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'helpdesk-api listening');
  });
}
