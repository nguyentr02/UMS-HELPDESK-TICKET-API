import { PrismaClient, type Notification } from '@prisma/client';
import { env } from '../config/env.js';
import { notificationSink } from './realtime.js';

// Hot-reload-safe singleton: tsx --watch re-imports modules, which would
// otherwise spawn a new PrismaClient per change and exhaust DB connections.
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

function createPrisma(): PrismaClient {
  const client = new PrismaClient({ log: ['warn', 'error'] });

  // Capture every created Notification into the active per-request realtime
  // sink (if any). Runs for creates inside interactive transactions too, so
  // the realtime middleware can push them over the socket AFTER the response —
  // and therefore the transaction — has committed. No-op outside a request.
  client.$use(async (params, next) => {
    const result = await next(params);
    if (params.model === 'Notification' && params.action === 'create') {
      notificationSink.getStore()?.push(result as Notification);
    }
    return result;
  });

  return client;
}

export const prisma: PrismaClient = globalForPrisma.__prisma ?? createPrisma();

if (env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}