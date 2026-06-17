import { PrismaClient, type Notification } from '@prisma/client';
import { env } from '../config/env.js';
import { realtimeSink } from './realtime.js';

// Hot-reload-safe singleton: tsx --watch re-imports modules, which would
// otherwise spawn a new PrismaClient per change and exhaust DB connections.
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

function createPrisma(): PrismaClient {
  const client = new PrismaClient({ log: ['warn', 'error'] });

  // Record into the active per-request realtime sink (if any): every created
  // Notification, and whether any Ticket row was written. Runs inside
  // interactive transactions too, so the realtime middleware can push over the
  // socket AFTER the response — and therefore the tx — has committed. No-op
  // outside a request.
  client.$use(async (params, next) => {
    const result = await next(params);
    const store = realtimeSink.getStore();
    if (store) {
      if (params.model === 'Notification' && params.action === 'create') {
        store.notifications.push(result as Notification);
      } else if (
        params.model === 'Ticket' &&
        ['create', 'update', 'updateMany', 'upsert', 'delete'].includes(params.action)
      ) {
        store.ticketTouched = true;
      }
    }
    return result;
  });

  return client;
}

export const prisma: PrismaClient = globalForPrisma.__prisma ?? createPrisma();

if (env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}