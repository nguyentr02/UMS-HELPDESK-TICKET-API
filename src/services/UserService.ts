import type { Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { SessionUser } from '../middleware/auth.js';

type AnyPrisma = typeof prisma | Prisma.TransactionClient;

/** Public DTO shape served by `GET /users` and `GET /users/:id`. */
export interface UserDTO {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  department: { id: string; code: string; name: string } | null;
}

export interface ListUsersQuery {
  role?: Role;
  departmentId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export interface UserListResult {
  items: UserDTO[];
  page: number;
  pageSize: number;
  total: number;
}

const USER_INCLUDE = {
  department: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.UserInclude;

type UserWithDept = Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }>;

/**
 * Project a user row to the public DTO. Sensitive fields (`passwordHash`,
 * `ssoSubject`, `googleId`, `avatarUrl`, `isActive`, timestamps) are
 * deliberately omitted — the perimeter test (`users.test.ts -X5`) asserts
 * they never appear in the response.
 */
function toUserDTO(row: UserWithDept): UserDTO {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    department: row.department,
  };
}

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

  /**
   * Paged user directory — read-only, Admin-only consumer (route gates the
   * authz; the service is permissive). Filters compose as AND. `search`
   * is a case-insensitive substring match against `displayName` OR `email`.
   */
  async list(query: ListUsersQuery, client: AnyPrisma = prisma): Promise<UserListResult> {
    const where: Prisma.UserWhereInput = {};
    if (query.role) where.role = query.role;
    if (query.departmentId) where.departmentId = query.departmentId;
    if (query.search) {
      const term = query.search.trim();
      if (term.length > 0) {
        where.OR = [
          { displayName: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
        ];
      }
    }

    const safePageSize = Math.min(Math.max(query.pageSize, 1), 100);
    const safePage = Math.max(query.page, 1);
    const skip = (safePage - 1) * safePageSize;

    const [rows, total] = await Promise.all([
      client.user.findMany({
        where,
        include: USER_INCLUDE,
        orderBy: [{ role: 'asc' }, { displayName: 'asc' }, { id: 'asc' }],
        skip,
        take: safePageSize,
      }),
      client.user.count({ where }),
    ]);

    return {
      items: rows.map(toUserDTO),
      page: safePage,
      pageSize: safePageSize,
      total,
    };
  },

  /** Read-only user lookup by id. Returns `null` when the user doesn't exist. */
  async getById(id: string, client: AnyPrisma = prisma): Promise<UserDTO | null> {
    const row = await client.user.findUnique({
      where: { id },
      include: USER_INCLUDE,
    });
    return row ? toUserDTO(row) : null;
  },
};
