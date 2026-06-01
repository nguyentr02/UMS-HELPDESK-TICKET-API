import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { SessionUser } from '../middleware/auth.js';

type AnyPrisma = typeof prisma | Prisma.TransactionClient;

export const UserService = {
  /**
   * Idempotently materializes the SSO session as a `User` row so foreign-key
   * constraints on Ticket / Comment / Event hold. Called from any mutation
   * that writes the caller into the DB for the first time.
   */
  ensureFromSession(session: SessionUser, client: AnyPrisma = prisma) {
    return client.user.upsert({
      where: { id: session.id },
      create: {
        id: session.id,
        ssoSubject: `mock:${session.id}`,
        email: `${session.id}@mock.local`,
        displayName: session.id,
        role: session.role,
        departmentId: session.departmentId,
      },
      update: {
        role: session.role,
        departmentId: session.departmentId,
      },
    });
  },
};
