import type { Role, TicketStatus } from '@prisma/client';
import type { SessionUser } from '../middleware/auth.js';
import { ForbiddenError } from './errors.js';

export type TransitionKey =
  | 'assign'
  | 'forward'
  | 'redirect'
  | 'progress'
  | 'close'
  | 'overrideSeverity';

export interface TransitionRule {
  /** Statuses from which this action is allowed. */
  allowedFrom: readonly TicketStatus[];
  /**
   * Resulting status. `null` means the status doesn't change (attribute-only update),
   * which is the case for `assign` and `overrideSeverity`.
   */
  to: TicketStatus | null;
  /** Roles statically allowed. Per-ticket checks (assignee, dept match) layer on top. */
  baseRoles: readonly Role[];
}

/**
 * The §C transition table as a typed map. Pre/post statuses and the base set of
 * roles allowed for each action. `assertCanPerform()` adds per-ticket guards
 * (e.g., DeptStaff can only `progress` tickets routed to their own dept).
 */
export const TRANSITIONS: Record<TransitionKey, TransitionRule> = {
  assign: {
    allowedFrom: ['Pending'],
    to: null,
    baseRoles: ['HelpdeskLead'],
  },
  forward: {
    allowedFrom: ['Pending'],
    to: 'Assigned',
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent'],
  },
  redirect: {
    // Re-route after assignment; FP §C: "Redirected → Assigned within same tx".
    allowedFrom: ['Assigned', 'InProgress'],
    to: 'Assigned',
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent'],
  },
  progress: {
    allowedFrom: ['Assigned'],
    to: 'InProgress',
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent', 'DeptStaff'],
  },
  close: {
    allowedFrom: ['Pending', 'Assigned', 'InProgress'],
    to: 'Closed',
    // HelpdeskAgent is only allowed when they're the assignee — checked below.
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent'],
  },
  overrideSeverity: {
    allowedFrom: ['Pending', 'Assigned', 'InProgress', 'Redirected'],
    to: null,
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent'],
  },
};

interface TicketContext {
  helpdeskAssigneeId: string | null;
  routedDepartmentId: string | null;
}

/**
 * Throws ForbiddenError if `caller` cannot perform `action` on this ticket. Combines
 * the static role table with per-ticket scope (assignee / dept match).
 */
export function assertCanPerform(
  action: TransitionKey,
  caller: SessionUser,
  ticket: TicketContext,
): void {
  const rule = TRANSITIONS[action];
  if (!rule.baseRoles.includes(caller.role)) {
    throw new ForbiddenError(`Vai trò ${caller.role} không thể thực hiện ${action}`);
  }
  // Per-ticket layered checks.
  if (action === 'progress' && caller.role === 'DeptStaff') {
    if (!caller.departmentId || caller.departmentId !== ticket.routedDepartmentId) {
      throw new ForbiddenError('Chỉ DeptStaff của phòng được phân công mới có thể bắt đầu xử lý');
    }
  }
  if (action === 'close' && caller.role === 'HelpdeskAgent') {
    if (ticket.helpdeskAssigneeId !== caller.id) {
      throw new ForbiddenError('Agent chỉ có thể đóng ticket được phân cho mình');
    }
  }
}
