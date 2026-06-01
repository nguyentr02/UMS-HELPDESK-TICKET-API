import type { Prisma } from '@prisma/client';
import type { SessionUser } from '../middleware/auth.js';
import { ForbiddenError } from './errors.js';

/**
 * Server-derived where-clause for ticket lists. Never trust a client-supplied
 * `departmentId` — the caller's role + dept on the session is the only source
 * of scoping authority.
 */
export function ticketWhereForCaller(caller: SessionUser): Prisma.TicketWhereInput {
  switch (caller.role) {
    case 'SV':
    case 'GV':
    case 'NV':
      return { requesterId: caller.id };

    case 'HelpdeskLead':
    case 'Admin':
      return {};

    case 'HelpdeskAgent':
      // FP §8: HelpdeskAgent's queue is *personal* — they see only tickets
      // that have been assigned to them. Unassigned tickets live on the Lead's
      // queue until the Lead assigns them.
      return { helpdeskAssigneeId: caller.id };

    case 'DeptStaff':
      // DeptStaff with no dept can't see any tickets — return an impossible filter.
      return caller.departmentId
        ? { routedDepartmentId: caller.departmentId }
        : { id: '__no_dept__' };
  }
}

/** Detail/history scoping. Throws 403 when the caller isn't allowed. */
export function assertCanViewTicket(
  caller: SessionUser,
  ticket: {
    requesterId: string;
    routedDepartmentId: string | null;
    helpdeskAssigneeId?: string | null;
  },
): void {
  switch (caller.role) {
    case 'HelpdeskLead':
    case 'Admin':
      return;

    case 'HelpdeskAgent':
      // Personal queue rule: an Agent can only open a ticket they own.
      if (ticket.helpdeskAssigneeId === caller.id) return;
      throw new ForbiddenError();

    case 'DeptStaff':
      if (caller.departmentId && caller.departmentId === ticket.routedDepartmentId) return;
      throw new ForbiddenError();

    case 'SV':
    case 'GV':
    case 'NV':
      if (ticket.requesterId === caller.id) return;
      throw new ForbiddenError();
  }
}
