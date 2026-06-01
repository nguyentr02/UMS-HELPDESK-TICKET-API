import type {
  Attachment,
  Category,
  Department,
  Notification,
  Ticket,
  TicketComment,
  TicketEvent,
  TicketStatus,
  User,
} from '@prisma/client';

// ─────────── Sub-DTOs ───────────

export interface UserRef {
  id: string;
  displayName: string;
}

export interface DepartmentDTO {
  id: string;
  code: string;
  name: string;
}

export interface CategoryDTO {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
}

export interface AttachmentDTO {
  id: string;
  ticketId: string;
  commentId: string | null;
  uploader: UserRef;
  filename: string;
  mimeType: string;
  kind: 'Image' | 'Document';
  sizeBytes: number;
  createdAt: Date;
}

export type ExternalStatus = 'Requested' | 'Processing' | 'Finished';

const INTERNAL_TO_EXTERNAL: Record<TicketStatus, ExternalStatus> = {
  Pending: 'Requested',
  Assigned: 'Requested',
  Redirected: 'Requested',
  InProgress: 'Processing',
  Closed: 'Finished',
};

// ─────────── Mappers ───────────

export function toUserRef(u: User): UserRef {
  return { id: u.id, displayName: u.displayName };
}
export function toUserRefOrNull(u: User | null): UserRef | null {
  return u ? toUserRef(u) : null;
}

export function toDepartmentDTO(d: Department): DepartmentDTO {
  return { id: d.id, code: d.code, name: d.name };
}
export function toDepartmentDTOOrNull(d: Department | null): DepartmentDTO | null {
  return d ? toDepartmentDTO(d) : null;
}

export function toCategoryDTO(c: Category | null): CategoryDTO | null {
  if (!c) return null;
  return { id: c.id, name: c.name, parentId: c.parentId, isActive: c.isActive };
}

export function toAttachmentDTO(att: Attachment & { uploader: User }): AttachmentDTO {
  return {
    id: att.id,
    ticketId: att.ticketId,
    commentId: att.commentId,
    uploader: toUserRef(att.uploader),
    filename: att.filename,
    mimeType: att.mimeType,
    kind: att.kind,
    sizeBytes: att.sizeBytes,
    createdAt: att.createdAt,
  };
}

export type TicketWithRelations = Ticket & {
  requester: User;
  helpdeskAssignee: User | null;
  routedDepartment: Department | null;
  category: Category | null;
  attachments: Array<Attachment & { uploader: User }>;
};

/** Standard `include` payload for any Prisma query that returns a Ticket via `toTicketDTO`. */
export const TICKET_INCLUDE = {
  requester: true,
  helpdeskAssignee: true,
  routedDepartment: true,
  category: true,
  attachments: { include: { uploader: true } },
} as const;

function backlogAgeDays(t: Pick<Ticket, 'createdAt' | 'status' | 'closedAt'>): number {
  const end = t.status === 'Closed' && t.closedAt ? t.closedAt.getTime() : Date.now();
  return Math.max(0, Math.floor((end - t.createdAt.getTime()) / 86_400_000));
}

export function toTicketDTO(t: TicketWithRelations) {
  return {
    id: t.id,
    code: t.code,
    title: t.title,
    description: t.description,
    severity: t.severity,
    internalStatus: t.status,
    externalStatus: INTERNAL_TO_EXTERNAL[t.status],
    category: toCategoryDTO(t.category),
    requester: toUserRef(t.requester),
    helpdeskAssignee: toUserRefOrNull(t.helpdeskAssignee),
    routedDepartment: toDepartmentDTOOrNull(t.routedDepartment),
    attachments: t.attachments.map(toAttachmentDTO),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    closedAt: t.closedAt,
    backlogAgeDays: backlogAgeDays(t),
  };
}

export type TicketEventWithActor = TicketEvent & { actor: User };
export const TICKET_EVENT_INCLUDE = { actor: true } as const;

export function toTicketEventDTO(e: TicketEventWithActor) {
  return {
    id: e.id,
    ticketId: e.ticketId,
    actor: toUserRef(e.actor),
    type: e.type,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    fromDepartmentId: e.fromDepartmentId,
    toDepartmentId: e.toDepartmentId,
    note: e.note,
    createdAt: e.createdAt,
  };
}

export type TicketCommentWithRelations = TicketComment & {
  author: User;
  attachments: Array<Attachment & { uploader: User }>;
};
export const TICKET_COMMENT_INCLUDE = {
  author: true,
  attachments: { include: { uploader: true } },
} as const;

export function toTicketCommentDTO(c: TicketCommentWithRelations) {
  return {
    id: c.id,
    ticketId: c.ticketId,
    author: toUserRef(c.author),
    body: c.body,
    createdAt: c.createdAt,
    attachments: c.attachments.map(toAttachmentDTO),
  };
}

export function toNotificationItemDTO(n: Notification) {
  return {
    id: n.id,
    type: n.type,
    ticketId: n.ticketId,
    payload: n.payload as Record<string, unknown>,
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}
