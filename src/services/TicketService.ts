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

const STATUS_OPEN: readonly TicketStatus[] = ['Pending', 'Assigned', 'InProgress'];
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
  categoryId?: string;
  assigneeId?: string;
  /** Free-text search across title / description / code (case-insensitive). */
  q?: string;
  /**
   * JSON:API-style sort key. Supported values (FE-defined in queue-filters.tsx):
   *  - `-createdAt` (default, newest first)
   *  - `createdAt`  (oldest first)
   *  - `-severity`  (Critical → Low)
   *  - `severity`   (Low → Critical)
   */
  sort?: string;
  page?: number;
  pageSize?: number;
}

const SEVERITY_RANK: Record<Severity, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

/**
 * Pre-uploaded attachment metadata (direct-to-Blob flow). The browser uploaded
 * the file straight to Vercel Blob via @vercel/blob/client and is now POSTing
 * just the resulting URL + metadata.
 */
export interface PreUploadedAttachment {
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface CreateInput {
  title: string;
  description: string;
  severity: Severity;
  categoryId?: string | null;
  /** Legacy multipart path — files arrived in the request body. */
  files?: IncomingFile[];
  /** Direct-upload path — files already in Blob, only metadata supplied. */
  attachments?: PreUploadedAttachment[];
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
      // Direct-upload (Blob) attachments — files already live, only metadata
      // arrives in the JSON body.
      for (const a of input.attachments ?? []) {
        await tx.attachment.create({
          data: {
            ticketId: ticket.id,
            uploaderId: caller.id,
            filename: a.filename,
            mimeType: a.mimeType,
            kind: kindFromMime(a.mimeType),
            sizeBytes: a.sizeBytes,
            storageKey: a.url,
          },
        });
      }
      // Fan-out to every active HelpdeskLead so they see new tickets in their
      // inbox (excluding the caller themselves on the off chance a Lead made
      // the ticket — they don't need to notify themselves).
      const leads = await tx.user.findMany({
        where: { role: 'HelpdeskLead', isActive: true, NOT: { id: caller.id } },
        select: { id: true },
      });
      for (const l of leads) {
        await tx.notification.create({
          data: {
            userId: l.id,
            type: 'TicketCreated',
            ticketId: ticket.id,
            payload: { ticketCode: code, requesterId: caller.id, severity: input.severity },
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
    const search = query.q?.trim();

    const where: Prisma.TicketWhereInput = {
      ...ticketWhereForCaller(caller),
      ...(statusFilter ? { status: { in: statusFilter } } : {}),
      ...(severityFilter ? { severity: { in: severityFilter } } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.assigneeId ? { helpdeskAssigneeId: query.assigneeId } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' as const } },
              { description: { contains: search, mode: 'insensitive' as const } },
              { code: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const sort = query.sort ?? '-createdAt';

    // Custom severity ranking can't be expressed via Prisma's orderBy (enum sorts
    // alphabetically, which would put Medium before High). Load matching ids
    // server-side, sort by our priority map, then refetch the page with full includes.
    if (sort === '-severity' || sort === 'severity') {
      const candidates = await prisma.ticket.findMany({
        where,
        select: { id: true, severity: true, createdAt: true },
      });
      candidates.sort((a, b) => {
        const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
        if (r !== 0) return sort === '-severity' ? r : -r;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });
      const total = candidates.length;
      const pageIds = candidates
        .slice((page - 1) * pageSize, page * pageSize)
        .map((c) => c.id);
      const items = await prisma.ticket.findMany({
        where: { id: { in: pageIds } },
        include: TICKET_INCLUDE,
      });
      const byId = new Map(items.map((t) => [t.id, t]));
      const ordered = pageIds
        .map((id) => byId.get(id))
        .filter((t): t is (typeof items)[number] => !!t);
      return {
        items: ordered.map(toTicketDTO),
        page: { page, pageSize, total },
      };
    }

    const orderBy: Prisma.TicketOrderByWithRelationInput =
      sort === 'createdAt' ? { createdAt: 'asc' } : { createdAt: 'desc' };

    const [total, items] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        orderBy,
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

  async listComments(id: string, caller: SessionUser) {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      select: { requesterId: true, routedDepartmentId: true, helpdeskAssigneeId: true },
    });
    if (!ticket) throw new NotFoundError('Không tìm thấy ticket');
    assertCanViewTicket(caller, ticket);
    const rows = await prisma.ticketComment.findMany({
      where: { ticketId: id },
      orderBy: { createdAt: 'asc' },
      include: TICKET_COMMENT_INCLUDE,
    });
    return rows.map(toTicketCommentDTO);
  },

  async getHistory(id: string, caller: SessionUser) {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      // helpdeskAssigneeId is required for the HelpdeskAgent personal-queue check.
      select: { requesterId: true, routedDepartmentId: true, helpdeskAssigneeId: true },
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

      // Notify the assigned agent (if any, and not the actor) about the move.
      if (before.helpdeskAssigneeId && before.helpdeskAssigneeId !== caller.id) {
        await tx.notification.create({
          data: {
            userId: before.helpdeskAssigneeId,
            type: 'StatusChanged',
            ticketId,
            payload: { ticketCode: before.code, status: 'Assigned', toDepartmentId: departmentId },
          },
        });
      }

      // Notify the requester — their ticket has been routed.
      if (before.requesterId !== caller.id) {
        await tx.notification.create({
          data: {
            userId: before.requesterId,
            type: 'StatusChanged',
            ticketId,
            payload: { ticketCode: before.code, status: 'Assigned', toDepartmentId: departmentId },
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

      // Notify the assigned agent too (if any, and not the actor) — the
      // ticket they own just moved to InProgress.
      if (before.helpdeskAssigneeId && before.helpdeskAssigneeId !== caller.id) {
        await tx.notification.create({
          data: {
            userId: before.helpdeskAssigneeId,
            type: 'StatusChanged',
            ticketId,
            payload: { ticketCode: before.code, status: 'InProgress' },
          },
        });
      }

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

      // Notify the assigned agent (if any, and not the actor) on close —
      // they likely care that a ticket they own just terminated.
      if (before.helpdeskAssigneeId && before.helpdeskAssigneeId !== caller.id) {
        await tx.notification.create({
          data: {
            userId: before.helpdeskAssigneeId,
            type: 'TicketClosed',
            ticketId,
            payload: { ticketCode: before.code, reason: reason ?? null },
          },
        });
      }

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
    attachmentsMeta: PreUploadedAttachment[] | undefined,
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
      for (const a of attachmentsMeta ?? []) {
        await tx.attachment.create({
          data: {
            ticketId,
            commentId: comment.id,
            uploaderId: caller.id,
            filename: a.filename,
            mimeType: a.mimeType,
            kind: kindFromMime(a.mimeType),
            sizeBytes: a.sizeBytes,
            storageKey: a.url,
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

      // Fan-out to every active HelpdeskLead. A comment can come from
      // requester/agent/staff — Lead is the only role we always notify.
      // (If the comment was made by a Lead themselves, skip them.)
      const leads = await tx.user.findMany({
        where: { role: 'HelpdeskLead', isActive: true, NOT: { id: caller.id } },
        select: { id: true },
      });
      for (const l of leads) {
        await tx.notification.create({
          data: {
            userId: l.id,
            type: 'TicketCommented',
            ticketId,
            payload: { ticketCode: ticket.code, authorId: caller.id, commentId: comment.id },
          },
        });
      }

      // Notify the assigned agent (if any, and not the comment author) — they
      // own this ticket and should see new activity on it.
      if (ticket.helpdeskAssigneeId && ticket.helpdeskAssigneeId !== caller.id) {
        await tx.notification.create({
          data: {
            userId: ticket.helpdeskAssigneeId,
            type: 'TicketCommented',
            ticketId,
            payload: { ticketCode: ticket.code, authorId: caller.id, commentId: comment.id },
          },
        });
      }

      // Notify the requester unless they're the one commenting.
      if (ticket.requesterId !== caller.id) {
        await tx.notification.create({
          data: {
            userId: ticket.requesterId,
            type: 'TicketCommented',
            ticketId,
            payload: { ticketCode: ticket.code, authorId: caller.id, commentId: comment.id },
          },
        });
      }

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

      const payload = {
        ticketCode: before.code,
        fromSeverity: before.severity,
        toSeverity: severity,
      };

      // Notify the requester — anything on their ticket should hit their inbox.
      if (before.requesterId !== caller.id) {
        await tx.notification.create({
          data: {
            userId: before.requesterId,
            type: 'StatusChanged',
            ticketId,
            payload,
          },
        });
      }

      // Notify the assigned agent (if any, and not the actor).
      if (before.helpdeskAssigneeId && before.helpdeskAssigneeId !== caller.id) {
        await tx.notification.create({
          data: {
            userId: before.helpdeskAssigneeId,
            type: 'StatusChanged',
            ticketId,
            payload,
          },
        });
      }

      return tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        include: TICKET_INCLUDE,
      });
    }).then(toTicketDTO);
  },
};
