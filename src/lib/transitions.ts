import type { Role, TicketStatus } from '@prisma/client';
import type { SessionUser } from '../middleware/auth.js';
import { ForbiddenError } from './errors.js';

export type TransitionKey =
  | 'assign'
  | 'forward'
  | 'redirect'
  | 'progress'
  | 'requestClose'
  | 'approveClose'
  | 'refuseClose'
  | 'requestRedirect'
  | 'approveRedirect'
  | 'refuseRedirect'
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
    // Attribute-only update (`to: null` — status doesn't change). Lead can pick
    // an agent at any open status: e.g. forward-to-dept first (Pending →
    // Assigned) and then assign the agent who'll handle it for the dept;
    // or reassign mid-progress. Symmetric with `overrideSeverity` below.
    allowedFrom: ['Pending', 'Assigned', 'InProgress'],
    to: null,
    baseRoles: ['HelpdeskLead'],
  },
  forward: {
    allowedFrom: ['Pending'],
    to: 'Assigned',
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent'],
  },
  // Re-route an already-routed ticket to a different department. Resets to
  // `Assigned` so the new dept starts fresh; the Helpdesk assignee is kept.
  redirect: {
    allowedFrom: ['Assigned', 'InProgress'],
    to: 'Assigned',
    // HelpdeskAgent only when they're the assignee — checked below.
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent'],
  },
  progress: {
    allowedFrom: ['Assigned'],
    to: 'InProgress',
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent', 'DeptStaff'],
  },
  // DeptStaff (of the routed dept) asks to close an in-progress ticket, with a
  // proof comment + optional images. Status → CloseRequested awaiting review.
  requestClose: {
    allowedFrom: ['InProgress'],
    to: 'CloseRequested',
    baseRoles: ['DeptStaff'],
  },
  // The owning Agent/Lead approves a pending close request → Closed.
  approveClose: {
    allowedFrom: ['CloseRequested'],
    to: 'Closed',
    // HelpdeskAgent only when they're the assignee — checked below.
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent'],
  },
  // The owning Agent/Lead refuses (reason required) → back to InProgress.
  refuseClose: {
    allowedFrom: ['CloseRequested'],
    to: 'InProgress',
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent'],
  },
  // DeptStaff (of the routed dept) asks to move the ticket to another dept,
  // with a reason. No target — the reviewing Agent/Lead picks the destination.
  requestRedirect: {
    allowedFrom: ['Assigned', 'InProgress'],
    to: 'RedirectRequested',
    baseRoles: ['DeptStaff'],
  },
  // Owning Agent/Lead approves a redirect request — picks the target dept →
  // Assigned (new dept). (Status restore handled in the service.)
  approveRedirect: {
    allowedFrom: ['RedirectRequested'],
    to: 'Assigned',
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent'],
  },
  // Owning Agent/Lead refuses (reason required) → back to the prior status.
  refuseRedirect: {
    allowedFrom: ['RedirectRequested'],
    to: null,
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent'],
  },
  close: {
    allowedFrom: ['Pending', 'Assigned', 'InProgress'],
    to: 'Closed',
    // HelpdeskAgent is only allowed when they're the assignee — checked below.
    baseRoles: ['HelpdeskLead', 'HelpdeskAgent'],
  },
  overrideSeverity: {
    allowedFrom: ['Pending', 'Assigned', 'InProgress'],
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
  if (
    (action === 'progress' || action === 'requestClose' || action === 'requestRedirect') &&
    caller.role === 'DeptStaff'
  ) {
    if (!caller.departmentId || caller.departmentId !== ticket.routedDepartmentId) {
      throw new ForbiddenError('Chỉ DeptStaff của phòng được phân công mới có thể thực hiện thao tác này');
    }
  }
  if (
    (action === 'close' ||
      action === 'approveClose' ||
      action === 'refuseClose' ||
      action === 'redirect' ||
      action === 'approveRedirect' ||
      action === 'refuseRedirect') &&
    caller.role === 'HelpdeskAgent'
  ) {
    if (ticket.helpdeskAssigneeId !== caller.id) {
      throw new ForbiddenError('Agent chỉ có thể xử lý ticket được phân cho mình');
    }
  }
}
