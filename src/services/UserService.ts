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
  async ensureFromSession(session: SessionUser, client: AnyPrisma = prisma) {
    // Only roles that actually need a dept (DeptStaff) should carry one.
    // For everyone else, ignore whatever the client sent — old mock data may
    // ship dept IDs that don't exist in the seeded DB (FK violation).
    // Also defensive: if the supplied dept id doesn't resolve, store null
    // instead of letting the upsert hit `users_departmentId_fkey`.
    let departmentId: string | null = null;
    if (session.role === 'DeptStaff' && session.departmentId) {
      const dept = await client.department.findUnique({
        where: { id: session.departmentId },
        select: { id: true },
      });
      departmentId = dept ? dept.id : null;
    }

    const displayName = session.displayName?.trim() || session.id;

    return client.user.upsert({
      where: { id: session.id },
      create: {
        id: session.id,
        ssoSubject: `mock:${session.id}`,
        email: `${session.id}@mock.local`,
        displayName,
        role: session.role,
        departmentId,
      },
      update: {
        // Refresh on every login so a previously seeded row gets the real name
        // the next time the same user makes a request.
        displayName,
        role: session.role,
        departmentId,
      },
    });
  },
};
