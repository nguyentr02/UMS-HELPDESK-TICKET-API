import type { Prisma, Severity, TicketStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { nextTicketCode } from '../lib/ids.js';
import { assertCanViewTicket, ticketWhereForCaller } from '../lib/scoping.js';
import { getStorage, kindFromMime, type IncomingFile } from '../lib/storage/index.js';
import type { SessionUser } from '../middleware/auth.js';
import { assertCanPerform, TRANSITIONS } from '../lib/transitions.js';
import { safePublishClosed, safePublishCreated } from '../lib/events/publisher.js';
import {
  TICKET_COMMENT_INCLUDE,
  TICKET_EVENT_INCLUDE,
  TICKET_INCLUDE,
  toTicketCommentDTO,
  toTicketDTO,
  toTicketEventDTO,
} from '../lib/dto.js';
import { UserService } from './UserService.js';

const STATUS_OPEN: readonly TicketStatus[] = ['Pending', 'Assigned', 'InProgress', 'Redirected'];
const STATUS_VALID: readonly TicketStatus[] = [...STATUS_OPEN, 'Closed'];
const SEVERITY_VALID: readonly Severity[] = ['Critical', 'High', 'Medium', 'Low'];

function parseStatusFilter(value: string | undefined): TicketStatus[] | undefined {
  if (!value) return undefined;
  if (value === 'open') return [...STATUS_OPEN];
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = parts.filter((p): p is TicketStatus => (STATUS_VALID as readonly string[]).includes(p));
  return valid.length > 0 ? valid : undefined;
}

function parseSeverityFilter(value: string | undefined): Severity[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = parts.filter((p): p is Severity => (SEVERITY_VALID as readonly string[]).includes(p));
  return valid.length > 0 ? valid : undefined;
}

export interface ListQuery {
  status?: string;
  severity?: string;
  page?: number;
  pageSize?: number;
}

export interface CreateInput {
  title: string;
  description: string;
  severity: Severity;
  categoryId?: string | null;
  files?: IncomingFile[];
}

export const TicketService = {
  async create(input: CreateInput, caller: SessionUser) {
    // 1. Make sure the requester exists as a User row (FK requirement).
    await UserService.ensureFromSession(caller);

    // 2. Optional category sanity check before the tx, for a clean 422.
    if (input.categoryId) {
      const cat = await prisma.category.findUnique({ where: { id: input.categoryId } });
      if (!cat) throw new ValidationError({ categoryId: 'Danh mục không tồn tại' });
    }

    // 3. Upload files outside the DB tx so storage errors short-circuit early.
    const uploaded = await Promise.all(
      (input.files ?? []).map(async (f) => ({
        file: f,
        stored: await getStorage().upload(f),
      })),
    );

    const created = await prisma.$transaction(async (tx) => {
      const code = await nextTicketCode(tx);
      const ticket = await tx.ticket.create({
        data: {
          code,
          title: input.title,
          description: input.description,
          severity: input.severity,
          status: 'Pending',
          requesterId: caller.id,
          categoryId: input.categoryId ?? null,
        },
      });
      await tx.ticketEvent.create({
        data: {
          ticketId: ticket.id,
          actorId: caller.id,
          type: 'Created',
          toStatus: 'Pending',
        },
      });
      for (const u of uploaded) {
        await tx.attachment.create({
          data: {
            ticketId: ticket.id,
            uploaderId: caller.id,
            filename: u.file.originalname,
            mimeType: u.file.mimetype,
            kind: kindFromMime(u.file.mimetype),
            sizeBytes: u.file.size,
            storageKey: u.stored.storageKey,
          },
        });
      }
      return tx.ticket.findUniqueOrThrow({
        where: { id: ticket.id },
        include: TICKET_INCLUDE,
      });
    });

    // Publish after the tx commits; failures swallowed inside safePublish.
    await safePublishCreated({
      type: 'ticketCreated',
      ticketId: created.id,
      code: created.code,
      severity: created.severity,
      requesterId: created.requesterId,
      createdAt: created.createdAt,
    });

    return toTicketDTO(created);
  },

  async list(query: ListQuery, caller: SessionUser) {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(query.pageSize ?? 20)));
    const statusFilter = parseStatusFilter(query.status);
    const severityFilter = parseSeverityFilter(query.severity);

    const where: Prisma.TicketWhereInput = {
      ...ticketWhereForCaller(caller),
      ...(statusFilter ? { status: { in: statusFilter } } : {}),
      ...(severityFilter ? { severity: { in: severityFilter } } : {}),
    };

    const [total, items] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: TICKET_INCLUDE,
      }),
    ]);

    return {
      items: items.map(toTicketDTO),
      page: { page, pageSize, total },
    };
  },

  async getById(id: string, caller: SessionUser) {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: TICKET_INCLUDE,
    });
    if (!ticket) throw new NotFoundError('Không tìm thấy ticket');
    assertCanViewTicket(caller, ticket);
    return toTicketDTO(ticket);
  },

  async getHistory(id: string, caller: SessionUser) {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      select: { requesterId: true, routedDepartmentId: true },
    });
    if (!ticket) throw new NotFoundError('Không tìm thấy ticket');
    assertCanViewTicket(caller, ticket);
    const events = await prisma.ticketEvent.findMany({
      where: { ticketId: id },
      orderBy: { createdAt: 'asc' },
      include: TICKET_EVENT_INCLUDE,
    });
    return events.map(toTicketEventDTO);
  },

  // ─────────────── State-machine transitions (BE-S5) ───────────────

  async forward(ticketId: string, departmentId: string, caller: SessionUser) {
    await UserService.ensureFromSession(caller);

    const dept = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!dept) throw new ValidationError({ departmentId: 'Phòng ban không tồn tại' });

    return prisma.$transaction(async (tx) => {
      const before = await tx.ticket.findUnique({ where: { id: ticketId } });
      if (!before) throw new NotFoundError('Không tìm thấy ticket');

      assertCanPerform('forward', caller, before);

      if (!TRANSITIONS.forward.allowedFrom.includes(before.status)) {
        throw new ConflictError(`Không thể forward khi ticket ở trạng thái ${before.status}`);
      }

      const updated = await tx.ticket.updateMany({
        where: { id: ticketId, status: before.status },
        data: { status: 'Assigned', routedDepartmentId: departmentId },
      });
      if (updated.count === 0) {
        throw new ConflictError('Trạng thái ticket đã thay đổi trong lúc xử lý');
      }

      await tx.ticketEvent.create({
        data: {
          ticketId,
          actorId: caller.id,
          type: 'Forwarded',
          fromStatus: before.status,
          toStatus: 'Assigned',
          fromDepartmentId: before.routedDepartmentId,
          toDepartmentId: departmentId,
        },
      });

      const staff = await tx.user.findMany({
        where: { role: 'DeptStaff', departmentId, isActive: true },
        select: { id: true },
      });
      for (const s of staff) {
        await tx.notification.create({
          data: {
            userId: s.id,
            type: 'TicketForwarded',
            ticketId,
            payload: { ticketCode: before.code, departmentId },
          },
        });
      }

      return tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        include: TICKET_INCLUDE,
      });
    }).then(toTicketDTO);
  },

  async redirect(
    ticketId: string,
    departmentId: string,
    reason: string | undefined,
    caller: SessionUser,
  ) {
    await UserService.ensureFromSession(caller);

    const dept = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!dept) throw new ValidationError({ departmentId: 'Phòng ban không tồn tại' });

    return prisma.$transaction(async (tx) => {
      const before = await tx.ticket.findUnique({ where: { id: ticketId } });
      if (!before) throw new NotFoundError('Không tìm thấy ticket');

      assertCanPerform('redirect', caller, before);

      if (!TRANSITIONS.redirect.allowedFrom.includes(before.status)) {
        throw new ConflictError(`Không thể redirect khi ticket ở trạng thái ${before.status}`);
      }

      // FP §C: "Redirected → Assigned within same tx" — net post-status is Assigned.
      const updated = await tx.ticket.updateMany({
        where: { id: ticketId, status: before.status },
        data: { status: 'Assigned', routedDepartmentId: departmentId },
      });
      if (updated.count === 0) {
        throw new ConflictError('Trạng thái ticket đã thay đổi trong lúc xử lý');
      }

      await tx.ticketEvent.create({
        data: {
          ticketId,
          actorId: caller.id,
          type: 'Redirected',
          fromStatus: before.status,
          toStatus: 'Assigned',
          fromDepartmentId: before.routedDepartmentId,
          toDepartmentId: departmentId,
          note: reason ?? null,
        },
      });

      const staff = await tx.user.findMany({
        where: { role: 'DeptStaff', departmentId, isActive: true },
        select: { id: true },
      });
      for (const s of staff) {
        await tx.notification.create({
          data: {
            userId: s.id,
            type: 'TicketForwarded',
            ticketId,
            payload: { ticketCode: before.code, departmentId, reason: reason ?? null },
          },
        });
      }

      return tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        include: TICKET_INCLUDE,
      });
    }).then(toTicketDTO);
  },

  async startProgress(ticketId: string, caller: SessionUser) {
    await UserService.ensureFromSession(caller);

    return prisma.$transaction(async (tx) => {
      const before = await tx.ticket.findUnique({ where: { id: ticketId } });
      if (!before) throw new NotFoundError('Không tìm thấy ticket');

      assertCanPerform('progress', caller, before);

      if (!TRANSITIONS.progress.allowedFrom.includes(before.status)) {
        throw new ConflictError(`Không thể bắt đầu xử lý khi ticket ở trạng thái ${before.status}`);
      }

      const updated = await tx.ticket.updateMany({
        where: { id: ticketId, status: before.status },
        data: { status: 'InProgress' },
      });
      if (updated.count === 0) {
        throw new ConflictError('Trạng thái ticket đã thay đổi trong lúc xử lý');
      }

      await tx.ticketEvent.create({
        data: {
          ticketId,
          actorId: caller.id,
          type: 'Started',
          fromStatus: before.status,
          toStatus: 'InProgress',
        },
      });

      await tx.notification.create({
        data: {
          userId: before.requesterId,
          type: 'StatusChanged',
          ticketId,
          payload: { ticketCode: before.code, status: 'InProgress' },
        },
      });

      return tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        include: TICKET_INCLUDE,
      });
    }).then(toTicketDTO);
  },

  async close(ticketId: string, reason: string | undefined, caller: SessionUser) {
    await UserService.ensureFromSession(caller);

    const closed = await prisma.$transaction(async (tx) => {
      const before = await tx.ticket.findUnique({ where: { id: ticketId } });
      if (!before) throw new NotFoundError('Không tìm thấy ticket');

      assertCanPerform('close', caller, before);

      if (!TRANSITIONS.close.allowedFrom.includes(before.status)) {
        throw new ConflictError(`Không thể đóng ticket ở trạng thái ${before.status}`);
      }

      const now = new Date();
      const updated = await tx.ticket.updateMany({
        where: { id: ticketId, status: before.status },
        data: { status: 'Closed', closedAt: now },
      });
      if (updated.count === 0) {
        throw new ConflictError('Trạng thái ticket đã thay đổi trong lúc xử lý');
      }

      await tx.ticketEvent.create({
        data: {
          ticketId,
          actorId: caller.id,
          type: 'Closed',
          fromStatus: before.status,
          toStatus: 'Closed',
          note: reason ?? null,
        },
      });

      await tx.notification.create({
        data: {
          userId: before.requesterId,
          type: 'TicketClosed',
          ticketId,
          payload: { ticketCode: before.code, reason: reason ?? null },
        },
      });

      return tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        include: TICKET_INCLUDE,
      });
    });

    await safePublishClosed({
      type: 'ticketClosed',
      ticketId: closed.id,
      code: closed.code,
      status: 'Closed',
      closedAt: closed.closedAt ?? new Date(),
      requesterId: closed.requesterId,
    });

    return toTicketDTO(closed);
  },

  async addComment(
    ticketId: string,
    body: string,
    files: IncomingFile[] | undefined,
    caller: SessionUser,
  ) {
    await UserService.ensureFromSession(caller);

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundError('Không tìm thấy ticket');

    // Visibility = comment authority. Anyone who can view the ticket
    // (requester, helpdesk, DeptStaff of routed dept, admin) can comment.
    assertCanViewTicket(caller, ticket);

    if (ticket.status === 'Closed') {
      throw new ConflictError('Không thể bình luận ticket đã đóng');
    }

    // Upload first, outside the DB tx (storage errors short-circuit cleanly).
    const uploaded = await Promise.all(
      (files ?? []).map(async (f) => ({
        file: f,
        stored: await getStorage().upload(f),
      })),
    );

    return prisma.$transaction(async (tx) => {
      const comment = await tx.ticketComment.create({
        data: {
          ticketId,
          authorId: caller.id,
          body: body.trim(),
        },
      });

      for (const u of uploaded) {
        await tx.attachment.create({
          data: {
            ticketId,
            commentId: comment.id,
            uploaderId: caller.id,
            filename: u.file.originalname,
            mimeType: u.file.mimetype,
            kind: kindFromMime(u.file.mimetype),
            sizeBytes: u.file.size,
            storageKey: u.stored.storageKey,
          },
        });
      }

      await tx.ticketEvent.create({
        data: {
          ticketId,
          actorId: caller.id,
          type: 'Commented',
        },
      });

      return tx.ticketComment.findUniqueOrThrow({
        where: { id: comment.id },
        include: TICKET_COMMENT_INCLUDE,
      });
    }).then(toTicketCommentDTO);
  },

  async overrideSeverity(ticketId: string, severity: Severity, caller: SessionUser) {
    await UserService.ensureFromSession(caller);

    return prisma.$transaction(async (tx) => {
      const before = await tx.ticket.findUnique({ where: { id: ticketId } });
      if (!before) throw new NotFoundError('Không tìm thấy ticket');

      assertCanPerform('overrideSeverity', caller, before);

      if (!TRANSITIONS.overrideSeverity.allowedFrom.includes(before.status)) {
        throw new ConflictError(`Không thể đổi mức độ khi ticket ở trạng thái ${before.status}`);
      }

      const updated = await tx.ticket.updateMany({
        where: { id: ticketId, status: before.status },
        data: { severity },
      });
      if (updated.count === 0) {
        throw new ConflictError('Trạng thái ticket đã thay đổi trong lúc xử lý');
      }

      await tx.ticketEvent.create({
        data: {
          ticketId,
          actorId: caller.id,
          type: 'SeverityChanged',
          fromStatus: before.status,
          toStatus: before.status,
          note: `${before.severity} -> ${severity}`,
        },
      });

      return tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        include: TICKET_INCLUDE,
      });
    }).then(toTicketDTO);
  },
};
