import type { Prisma } from '@prisma/client';
import type { SessionUser } from '../middleware/auth';
import { ForbiddenError } from './errors';

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
    case 'HelpdeskAgent':
    case 'Admin':
      return {};

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
  ticket: { requesterId: string; routedDepartmentId: string | null },
): void {
  switch (caller.role) {
    case 'HelpdeskLead':
    case 'HelpdeskAgent':
    case 'Admin':
      return;

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
