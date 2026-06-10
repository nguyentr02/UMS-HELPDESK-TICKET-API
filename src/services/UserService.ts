import type { Prisma, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
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
    // Soft-deleted users (isActive=false via `deactivate`) are hidden from the
    // directory — a "deleted" user must disappear from the list. There's no
    // re-activation path inside Helpdesk; that lives in M1/IAM.
    const where: Prisma.UserWhereInput = { isActive: true };
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

  /**
   * Admin-only user creation. The route gates authz; this service enforces
   * the data invariants:
   *   - email is lower-cased and must be unique (409)
   *   - role=DeptStaff requires a departmentId (422 field error)
   *   - when departmentId is provided it must resolve to a real dept (422)
   *   - password is optional; when set, hashed with bcrypt (cost 10).
   *     Blank password = SSO-only login (verifyCredentials returns 401).
   */
  async create(
    input: CreateUserInput,
    client: AnyPrisma = prisma,
  ): Promise<UserDTO> {
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();

    if (input.role === 'DeptStaff' && !input.departmentId) {
      throw new ValidationError({ departmentId: 'Bắt buộc cho vai trò DeptStaff' });
    }

    let departmentId: string | null = null;
    if (input.departmentId) {
      const dept = await client.department.findUnique({
        where: { id: input.departmentId },
        select: { id: true },
      });
      if (!dept) throw new ValidationError({ departmentId: 'Phòng ban không tồn tại' });
      departmentId = dept.id;
    }

    const existing = await client.user.findUnique({
      where: { email },
      select: { id: true, isActive: true },
    });
    // An ACTIVE row owns the email → real conflict. A DEACTIVATED row → revive
    // it (email is `@unique`, so soft-delete keeps the address reserved; we
    // reuse the row instead of 409'ing). The revived account keeps its id, so
    // past tickets / comments / events stay attached.
    if (existing && existing.isActive) throw new ConflictError('Email đã được sử dụng');

    const passwordHash = input.password ? await bcrypt.hash(input.password, 10) : null;

    if (existing && !existing.isActive) {
      const revived = await client.user.update({
        where: { id: existing.id },
        data: {
          displayName,
          role: input.role,
          departmentId,
          passwordHash,
          isActive: true,
          // ssoSubject is left untouched — same email, same row; no need to
          // disturb any existing SSO linkage.
        },
        include: USER_INCLUDE,
      });
      return toUserDTO(revived);
    }

    // `ssoSubject` is `String @unique` in the schema (required, non-null) — set
    // a deterministic local-mode placeholder. Uniqueness is guaranteed by the
    // already-unique email; the `local:` prefix keeps it distinct from real
    // SSO subjects ("mock:<id>" used by tests / "google:<sub>" used by OAuth).
    const created = await client.user.create({
      data: {
        email,
        displayName,
        role: input.role,
        departmentId,
        passwordHash,
        ssoSubject: `local:${email}`,
      },
      include: USER_INCLUDE,
    });

    return toUserDTO(created);
  },

  /**
   * Admin-only partial update. Validates:
   *   - 404 if the user doesn't exist
   *   - 422 if `password` is provided and shorter than 8 chars
   *   - 422 if the resolved role is DeptStaff and the resolved departmentId is null
   *   - 422 if a non-null departmentId is supplied that doesn't resolve to a real dept
   *
   * Email is **not** mutable — changing the login id is a separate concern
   * (M1/IAM owns identity). `isActive` is also not exposed here; use
   * `deactivate()` for the off path and a future endpoint for re-activation.
   */
  async update(
    id: string,
    input: UpdateUserInput,
    client: AnyPrisma = prisma,
  ): Promise<UserDTO> {
    const current = await client.user.findUnique({
      where: { id },
      select: { id: true, role: true, departmentId: true },
    });
    if (!current) throw new NotFoundError('Không tìm thấy người dùng');

    if (input.password != null && input.password.length < 8) {
      throw new ValidationError({ password: 'Mật khẩu tối thiểu 8 ký tự' });
    }

    // Resolve departmentId: undefined => keep current; null => clear; string => verify.
    let nextDeptId: string | null;
    if (input.departmentId === undefined) {
      nextDeptId = current.departmentId;
    } else if (input.departmentId === null) {
      nextDeptId = null;
    } else {
      const dept = await client.department.findUnique({
        where: { id: input.departmentId },
        select: { id: true },
      });
      if (!dept) throw new ValidationError({ departmentId: 'Phòng ban không tồn tại' });
      nextDeptId = dept.id;
    }

    const nextRole = input.role ?? current.role;
    if (nextRole === 'DeptStaff' && !nextDeptId) {
      throw new ValidationError({ departmentId: 'Bắt buộc cho vai trò DeptStaff' });
    }

    const data: Prisma.UserUpdateInput = {};
    if (input.displayName !== undefined) data.displayName = input.displayName.trim();
    if (input.role !== undefined) data.role = input.role;
    if (input.departmentId !== undefined) {
      data.department = nextDeptId
        ? { connect: { id: nextDeptId } }
        : { disconnect: true };
    }
    if (input.password) {
      data.passwordHash = await bcrypt.hash(input.password, 10);
    }

    const updated = await client.user.update({
      where: { id },
      data,
      include: USER_INCLUDE,
    });
    return toUserDTO(updated);
  },

  /**
   * Admin-only soft delete — sets `isActive=false`. Idempotent: deactivating
   * an already-inactive user returns the same DTO. Refuses to deactivate the
   * caller themselves (callerId) so an Admin can't lock themselves out.
   *
   * Tickets / comments / events / notifications keep their FK pointing at
   * this row, so history is preserved even if the user can no longer log in.
   */
  async deactivate(
    id: string,
    callerId: string,
    client: AnyPrisma = prisma,
  ): Promise<UserDTO> {
    if (id === callerId) {
      throw new ConflictError('Không thể tự xóa chính bạn');
    }
    const target = await client.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!target) throw new NotFoundError('Không tìm thấy người dùng');

    const updated = await client.user.update({
      where: { id },
      data: { isActive: false },
      include: USER_INCLUDE,
    });
    return toUserDTO(updated);
  },
};

export interface CreateUserInput {
  email: string;
  displayName: string;
  role: Role;
  departmentId?: string | null;
  /** Optional. Blank => user can only sign in via Google SSO. */
  password?: string | null;
}

/**
 * Partial update — every field is optional. Omitted fields keep their current
 * DB value. Passing `null` for `departmentId` clears it (sets the column to NULL).
 * Passing `null` or omitting `password` leaves the existing hash alone.
 */
export interface UpdateUserInput {
  displayName?: string;
  role?: Role;
  /** `null` clears the dept; omit to keep the current value. */
  departmentId?: string | null;
  /** Sets a new bcrypt hash. Omit / null = unchanged. */
  password?: string | null;
}
