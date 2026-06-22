import type { Prisma, Severity, TicketStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
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
  TICKET_LIST_INCLUDE,
  toTicketCommentDTO,
  toTicketDTO,
  toTicketEventDTO,
} from '../lib/dto.js';
import { UserService } from './UserService.js';

const STATUS_OPEN: readonly TicketStatus[] = ['Pending', 'Assigned', 'InProgress', 'CloseRequested', 'RedirectRequested'];
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
  /**
   * Optional at create time — Lead / Agent triages and overrides via
   * PATCH /:id/severity. Defaults to `Medium` when omitted.
   */
  severity?: Severity;
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

    // Requesters no longer pick a severity — Lead/Agent triages later.
    // Default to Medium so the row is valid; PATCH /:id/severity overrides.
    const severity: Severity = input.severity ?? 'Medium';

    const created = await prisma.$transaction(async (tx) => {
      const code = await nextTicketCode(tx);
      const ticket = await tx.ticket.create({
        data: {
          code,
          title: input.title,
          description: input.description,
          severity,
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
            payload: { ticketCode: code, requesterId: caller.id, severity },
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
        include: TICKET_LIST_INCLUDE,
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
        include: TICKET_LIST_INCLUDE,
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

  /**
   * Re-route an already-routed ticket (Assigned/InProgress) to a different
   * department. Resets to `Assigned` so the new dept starts fresh; the
   * Helpdesk assignee is kept. Reason required; target must differ from the
   * current dept. Notifies the new dept's staff + requester.
   */
  async redirect(
    ticketId: string,
    departmentId: string,
    reason: string,
    caller: SessionUser,
  ) {
    await UserService.ensureFromSession(caller);

    if (!reason.trim()) throw new ValidationError({ reason: 'Cần lý do chuyển phòng ban' });

    const dept = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!dept) throw new ValidationError({ departmentId: 'Phòng ban không tồn tại' });

    return prisma
      .$transaction(async (tx) => {
        const before = await tx.ticket.findUnique({ where: { id: ticketId } });
        if (!before) throw new NotFoundError('Không tìm thấy ticket');

        assertCanPerform('redirect', caller, before);

        if (!TRANSITIONS.redirect.allowedFrom.includes(before.status)) {
          throw new ConflictError(`Không thể chuyển phòng ban khi ticket ở trạng thái ${before.status}`);
        }
        if (before.routedDepartmentId === departmentId) {
          throw new ValidationError({ departmentId: 'Ticket đã thuộc phòng ban này' });
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
            type: 'Redirected',
            fromStatus: before.status,
            toStatus: 'Assigned',
            fromDepartmentId: before.routedDepartmentId,
            toDepartmentId: departmentId,
            note: reason.trim(),
          },
        });

        const staff = await tx.user.findMany({
          where: { role: 'DeptStaff', departmentId, isActive: true },
          select: { id: true },
        });
        for (const sft of staff) {
          await tx.notification.create({
            data: {
              userId: sft.id,
              type: 'TicketForwarded',
              ticketId,
              payload: { ticketCode: before.code, departmentId },
            },
          });
        }

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

        return tx.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: TICKET_INCLUDE });
      })
      .then(toTicketDTO);
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

  /**
   * DeptStaff (of the routed dept) submits a close request with a proof comment
   * (required) + optional images. Status InProgress → CloseRequested; the owning
   * Agent/Lead must approve or refuse. The proof lives as a normal comment in the
   * timeline; `closeRequestedById` records who asked so we can notify them on the
   * decision.
   */
  async requestClose(
    ticketId: string,
    note: string,
    files: IncomingFile[] | undefined,
    attachmentsMeta: PreUploadedAttachment[] | undefined,
    caller: SessionUser,
  ) {
    await UserService.ensureFromSession(caller);

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundError('Không tìm thấy ticket');

    assertCanPerform('requestClose', caller, ticket);

    if (!TRANSITIONS.requestClose.allowedFrom.includes(ticket.status)) {
      throw new ConflictError(`Không thể yêu cầu đóng khi ticket ở trạng thái ${ticket.status}`);
    }
    if (!note.trim()) {
      throw new ValidationError({ note: 'Cần mô tả công việc đã hoàn thành' });
    }

    // Upload outside the DB tx (storage errors short-circuit cleanly).
    const uploaded = await Promise.all(
      (files ?? []).map(async (f) => ({ file: f, stored: await getStorage().upload(f) })),
    );

    return prisma
      .$transaction(async (tx) => {
        const comment = await tx.ticketComment.create({
          data: { ticketId, authorId: caller.id, body: note.trim() },
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

        const updated = await tx.ticket.updateMany({
          where: { id: ticketId, status: ticket.status },
          data: { status: 'CloseRequested', closeRequestedById: caller.id },
        });
        if (updated.count === 0) {
          throw new ConflictError('Trạng thái ticket đã thay đổi trong lúc xử lý');
        }

        await tx.ticketEvent.create({
          data: {
            ticketId,
            actorId: caller.id,
            type: 'CloseRequested',
            fromStatus: ticket.status,
            toStatus: 'CloseRequested',
          },
        });

        // Notify whoever can decide: the assigned agent (if any) + every active
        // Lead (so a request is never left unseen). Skip the actor.
        const recipients = new Set<string>();
        if (ticket.helpdeskAssigneeId) recipients.add(ticket.helpdeskAssigneeId);
        const leads = await tx.user.findMany({
          where: { role: 'HelpdeskLead', isActive: true },
          select: { id: true },
        });
        for (const l of leads) recipients.add(l.id);
        recipients.delete(caller.id);
        for (const userId of recipients) {
          await tx.notification.create({
            data: {
              userId,
              type: 'CloseRequested',
              ticketId,
              payload: { ticketCode: ticket.code, requestedById: caller.id, commentId: comment.id },
            },
          });
        }

        return tx.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: TICKET_INCLUDE });
      })
      .then(toTicketDTO);
  },

  /**
   * Owning Agent/Lead approves a pending close request → Closed. Notifies the
   * requester (TicketClosed) and the DeptStaff who asked.
   */
  async approveClose(ticketId: string, reason: string | undefined, caller: SessionUser) {
    await UserService.ensureFromSession(caller);

    const closed = await prisma.$transaction(async (tx) => {
      const before = await tx.ticket.findUnique({ where: { id: ticketId } });
      if (!before) throw new NotFoundError('Không tìm thấy ticket');

      assertCanPerform('approveClose', caller, before);

      if (!TRANSITIONS.approveClose.allowedFrom.includes(before.status)) {
        throw new ConflictError(`Không thể duyệt đóng khi ticket ở trạng thái ${before.status}`);
      }

      const now = new Date();
      const updated = await tx.ticket.updateMany({
        where: { id: ticketId, status: before.status },
        data: { status: 'Closed', closedAt: now, closeRequestedById: null },
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

      // Notify the DeptStaff who requested the close (if any, and not the actor).
      if (before.closeRequestedById && before.closeRequestedById !== caller.id) {
        await tx.notification.create({
          data: {
            userId: before.closeRequestedById,
            type: 'TicketClosed',
            ticketId,
            payload: { ticketCode: before.code, reason: reason ?? null },
          },
        });
      }

      return tx.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: TICKET_INCLUDE });
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

  /**
   * Owning Agent/Lead refuses a pending close request (reason required) →
   * back to InProgress. Notifies the DeptStaff who asked so they can redo.
   */
  async refuseClose(ticketId: string, reason: string, caller: SessionUser) {
    await UserService.ensureFromSession(caller);

    if (!reason.trim()) {
      throw new ValidationError({ reason: 'Cần lý do từ chối' });
    }

    return prisma
      .$transaction(async (tx) => {
        const before = await tx.ticket.findUnique({ where: { id: ticketId } });
        if (!before) throw new NotFoundError('Không tìm thấy ticket');

        assertCanPerform('refuseClose', caller, before);

        if (!TRANSITIONS.refuseClose.allowedFrom.includes(before.status)) {
          throw new ConflictError(`Không thể từ chối đóng khi ticket ở trạng thái ${before.status}`);
        }

        const requestedById = before.closeRequestedById;
        const updated = await tx.ticket.updateMany({
          where: { id: ticketId, status: before.status },
          data: { status: 'InProgress', closeRequestedById: null },
        });
        if (updated.count === 0) {
          throw new ConflictError('Trạng thái ticket đã thay đổi trong lúc xử lý');
        }

        await tx.ticketEvent.create({
          data: {
            ticketId,
            actorId: caller.id,
            type: 'CloseRefused',
            fromStatus: before.status,
            toStatus: 'InProgress',
            note: reason.trim(),
          },
        });

        if (requestedById && requestedById !== caller.id) {
          await tx.notification.create({
            data: {
              userId: requestedById,
              type: 'CloseRefused',
              ticketId,
              payload: { ticketCode: before.code, reason: reason.trim() },
            },
          });
        }

        return tx.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: TICKET_INCLUDE });
      })
      .then(toTicketDTO);
  },

  /**
   * DeptStaff (of the routed dept) asks to move the ticket to another dept,
   * with a reason. No target — the reviewing Agent/Lead picks the destination.
   * Status {Assigned|InProgress} → RedirectRequested; remembers who asked.
   */
  async requestRedirect(ticketId: string, reason: string, caller: SessionUser) {
    await UserService.ensureFromSession(caller);

    if (!reason.trim()) throw new ValidationError({ reason: 'Cần lý do xin chuyển phòng ban' });

    return prisma
      .$transaction(async (tx) => {
        const before = await tx.ticket.findUnique({ where: { id: ticketId } });
        if (!before) throw new NotFoundError('Không tìm thấy ticket');

        assertCanPerform('requestRedirect', caller, before);

        if (!TRANSITIONS.requestRedirect.allowedFrom.includes(before.status)) {
          throw new ConflictError(`Không thể xin chuyển phòng ban khi ticket ở trạng thái ${before.status}`);
        }

        const updated = await tx.ticket.updateMany({
          where: { id: ticketId, status: before.status },
          data: { status: 'RedirectRequested', redirectRequestedById: caller.id },
        });
        if (updated.count === 0) {
          throw new ConflictError('Trạng thái ticket đã thay đổi trong lúc xử lý');
        }

        await tx.ticketEvent.create({
          data: {
            ticketId,
            actorId: caller.id,
            type: 'RedirectRequested',
            fromStatus: before.status,
            toStatus: 'RedirectRequested',
            note: reason.trim(),
          },
        });

        // Notify whoever can decide: the assigned agent (if any) + every Lead.
        const recipients = new Set<string>();
        if (before.helpdeskAssigneeId) recipients.add(before.helpdeskAssigneeId);
        const leads = await tx.user.findMany({
          where: { role: 'HelpdeskLead', isActive: true },
          select: { id: true },
        });
        for (const l of leads) recipients.add(l.id);
        recipients.delete(caller.id);
        for (const userId of recipients) {
          await tx.notification.create({
            data: {
              userId,
              type: 'RedirectRequested',
              ticketId,
              payload: { ticketCode: before.code, requestedById: caller.id, reason: reason.trim() },
            },
          });
        }

        return tx.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: TICKET_INCLUDE });
      })
      .then(toTicketDTO);
  },

  /**
   * Owning Agent/Lead approves a redirect request — picks the target dept
   * (≠ current). RedirectRequested → Assigned (new dept); assignee kept.
   * Notifies the new dept's staff + the requesting staff + the requester.
   */
  async approveRedirect(
    ticketId: string,
    departmentId: string,
    note: string | undefined,
    caller: SessionUser,
  ) {
    await UserService.ensureFromSession(caller);

    const dept = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!dept) throw new ValidationError({ departmentId: 'Phòng ban không tồn tại' });

    return prisma
      .$transaction(async (tx) => {
        const before = await tx.ticket.findUnique({ where: { id: ticketId } });
        if (!before) throw new NotFoundError('Không tìm thấy ticket');

        assertCanPerform('approveRedirect', caller, before);

        if (!TRANSITIONS.approveRedirect.allowedFrom.includes(before.status)) {
          throw new ConflictError(`Không thể duyệt chuyển phòng ban khi ticket ở trạng thái ${before.status}`);
        }
        if (before.routedDepartmentId === departmentId) {
          throw new ValidationError({ departmentId: 'Ticket đã thuộc phòng ban này' });
        }

        const updated = await tx.ticket.updateMany({
          where: { id: ticketId, status: before.status },
          data: { status: 'Assigned', routedDepartmentId: departmentId, redirectRequestedById: null },
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
            note: note?.trim() || null,
          },
        });

        const staff = await tx.user.findMany({
          where: { role: 'DeptStaff', departmentId, isActive: true },
          select: { id: true },
        });
        for (const sft of staff) {
          await tx.notification.create({
            data: {
              userId: sft.id,
              type: 'TicketForwarded',
              ticketId,
              payload: { ticketCode: before.code, departmentId },
            },
          });
        }

        // Tell the staffer who asked that their request was approved + moved.
        if (before.redirectRequestedById && before.redirectRequestedById !== caller.id) {
          await tx.notification.create({
            data: {
              userId: before.redirectRequestedById,
              type: 'StatusChanged',
              ticketId,
              payload: { ticketCode: before.code, status: 'Assigned', toDepartmentId: departmentId },
            },
          });
        }
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

        return tx.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: TICKET_INCLUDE });
      })
      .then(toTicketDTO);
  },

  /**
   * Owning Agent/Lead refuses a redirect request (reason required) → back to
   * the prior status (Assigned/InProgress, read from the request event).
   * Notifies the DeptStaff who asked.
   */
  async refuseRedirect(ticketId: string, reason: string, caller: SessionUser) {
    await UserService.ensureFromSession(caller);

    if (!reason.trim()) throw new ValidationError({ reason: 'Cần lý do từ chối' });

    return prisma
      .$transaction(async (tx) => {
        const before = await tx.ticket.findUnique({ where: { id: ticketId } });
        if (!before) throw new NotFoundError('Không tìm thấy ticket');

        assertCanPerform('refuseRedirect', caller, before);

        if (!TRANSITIONS.refuseRedirect.allowedFrom.includes(before.status)) {
          throw new ConflictError(`Không thể từ chối chuyển phòng ban khi ticket ở trạng thái ${before.status}`);
        }

        // Restore the status the ticket had when the request was made.
        const reqEvent = await tx.ticketEvent.findFirst({
          where: { ticketId, type: 'RedirectRequested' },
          orderBy: { createdAt: 'desc' },
          select: { fromStatus: true },
        });
        const priorStatus =
          reqEvent?.fromStatus === 'Assigned' || reqEvent?.fromStatus === 'InProgress'
            ? reqEvent.fromStatus
            : 'InProgress';
        const requestedById = before.redirectRequestedById;

        const updated = await tx.ticket.updateMany({
          where: { id: ticketId, status: before.status },
          data: { status: priorStatus, redirectRequestedById: null },
        });
        if (updated.count === 0) {
          throw new ConflictError('Trạng thái ticket đã thay đổi trong lúc xử lý');
        }

        await tx.ticketEvent.create({
          data: {
            ticketId,
            actorId: caller.id,
            type: 'RedirectRefused',
            fromStatus: 'RedirectRequested',
            toStatus: priorStatus,
            note: reason.trim(),
          },
        });

        if (requestedById && requestedById !== caller.id) {
          await tx.notification.create({
            data: {
              userId: requestedById,
              type: 'RedirectRefused',
              ticketId,
              payload: { ticketCode: before.code, reason: reason.trim() },
            },
          });
        }

        return tx.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: TICKET_INCLUDE });
      })
      .then(toTicketDTO);
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

  /**
   * Re-categorise a ticket. HelpdeskLead + HelpdeskAgent only. Quiet update
   * by design — no TicketEvent, no notifications. Pass `categoryId: null` to
   * clear the category back to "unsorted". 404 if the ticket doesn't exist,
   * 403 if the role isn't allowed, 409 if the ticket is Closed, 422 if the
   * categoryId doesn't refer to a real category.
   */
  async assignCategory(
    ticketId: string,
    categoryId: string | null,
    caller: SessionUser,
  ) {
    await UserService.ensureFromSession(caller);

    if (caller.role !== 'HelpdeskLead' && caller.role !== 'HelpdeskAgent') {
      throw new ForbiddenError('Chỉ Helpdesk có thể phân loại ticket');
    }

    if (categoryId) {
      const cat = await prisma.category.findUnique({ where: { id: categoryId } });
      if (!cat) throw new ValidationError({ categoryId: 'Danh mục không tồn tại' });
    }

    const before = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!before) throw new NotFoundError('Không tìm thấy ticket');
    if (before.status === 'Closed') {
      throw new ConflictError('Không thể phân loại ticket đã đóng');
    }

    await prisma.ticket.update({
      where: { id: ticketId },
      data: { categoryId },
    });

    const updated = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      include: TICKET_INCLUDE,
    });
    return toTicketDTO(updated);
  },
};
