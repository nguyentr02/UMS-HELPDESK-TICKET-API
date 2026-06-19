import { describe, expect, it } from 'vitest';

import { ForbiddenError } from '../../src/lib/errors.js';
import { assertCanViewTicket, ticketWhereForCaller } from '../../src/lib/scoping.js';
import type { SessionUser } from '../../src/middleware/auth.js';

const caller = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 'u1',
  role: 'DeptStaff',
  departmentId: null,
  ...over,
});

const ticket = (over: Partial<Parameters<typeof assertCanViewTicket>[1]> = {}) => ({
  requesterId: 'r1',
  routedDepartmentId: null,
  helpdeskAssigneeId: null,
  ...over,
});

describe('assertCanViewTicket — per-object scoping (IDOR guard)', () => {
  it('DeptStaff: CAN view a ticket routed to their own dept (incl. closed — no status gate)', () => {
    expect(() =>
      assertCanViewTicket(caller({ role: 'DeptStaff', departmentId: 'd1' }), ticket({ routedDepartmentId: 'd1' })),
    ).not.toThrow();
  });

  it('DeptStaff: 403 once the ticket is routed to ANOTHER dept (redirected away)', () => {
    expect(() =>
      assertCanViewTicket(caller({ role: 'DeptStaff', departmentId: 'd1' }), ticket({ routedDepartmentId: 'd2' })),
    ).toThrow(ForbiddenError);
  });

  it('DeptStaff: 403 when they have no department', () => {
    expect(() =>
      assertCanViewTicket(caller({ role: 'DeptStaff', departmentId: null }), ticket({ routedDepartmentId: 'd1' })),
    ).toThrow(ForbiddenError);
  });

  it('HelpdeskLead / Admin: can view any ticket', () => {
    expect(() => assertCanViewTicket(caller({ role: 'HelpdeskLead' }), ticket({ routedDepartmentId: 'dx' }))).not.toThrow();
    expect(() => assertCanViewTicket(caller({ role: 'Admin' }), ticket())).not.toThrow();
  });

  it('HelpdeskAgent: only a ticket assigned to them', () => {
    expect(() =>
      assertCanViewTicket(caller({ role: 'HelpdeskAgent', id: 'a1' }), ticket({ helpdeskAssigneeId: 'a1' })),
    ).not.toThrow();
    expect(() =>
      assertCanViewTicket(caller({ role: 'HelpdeskAgent', id: 'a1' }), ticket({ helpdeskAssigneeId: 'a2' })),
    ).toThrow(ForbiddenError);
  });

  it('Requester (SV/GV/NV): only their own ticket', () => {
    expect(() =>
      assertCanViewTicket(caller({ role: 'SV', id: 'r1' }), ticket({ requesterId: 'r1' })),
    ).not.toThrow();
    expect(() =>
      assertCanViewTicket(caller({ role: 'SV', id: 'r1' }), ticket({ requesterId: 'r2' })),
    ).toThrow(ForbiddenError);
  });
});

describe('ticketWhereForCaller — list scoping', () => {
  it('DeptStaff scopes to their department', () => {
    expect(ticketWhereForCaller(caller({ role: 'DeptStaff', departmentId: 'd1' }))).toEqual({
      routedDepartmentId: 'd1',
    });
  });
  it('DeptStaff with no dept gets an impossible filter (sees nothing)', () => {
    expect(ticketWhereForCaller(caller({ role: 'DeptStaff', departmentId: null }))).toEqual({ id: '__no_dept__' });
  });
  it('Lead / Admin: unscoped', () => {
    expect(ticketWhereForCaller(caller({ role: 'HelpdeskLead' }))).toEqual({});
    expect(ticketWhereForCaller(caller({ role: 'Admin' }))).toEqual({});
  });
  it('HelpdeskAgent: personal (assigned-to-me) queue', () => {
    expect(ticketWhereForCaller(caller({ role: 'HelpdeskAgent', id: 'a1' }))).toEqual({ helpdeskAssigneeId: 'a1' });
  });
  it('Requester: own tickets', () => {
    expect(ticketWhereForCaller(caller({ role: 'SV', id: 'r1' }))).toEqual({ requesterId: 'r1' });
  });
});