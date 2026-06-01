import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

// Hot-reload-safe singleton: tsx --watch re-imports modules, which would
// otherwise spawn a new PrismaClient per change and exhaust DB connections.
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}
