import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Severity, TicketStatus } from '@prisma/client';
import { createTestApp } from '../helpers/app-factory';
import { mockSsoHeaders } from '../helpers/sso-headers';
import { runSeed } from '../../prisma/seed';
import { disconnect, resetDb, testPrisma as prisma } from '../helpers/test-db';

const app = createTestApp();

interface TestSetup {
  csvcDeptId: string;
  hcnsDeptId: string;
  leadHeaders: Record<string, string>;
  agent1Headers: Record<string, string>;
  agent2Headers: Record<string, string>;
  staffCsvcHeaders: Record<string, string>;
  staffHcnsHeaders: Record<string, string>;
  svHeaders: Record<string, string>;
}

async function setupUsers(): Promise<TestSetup> {
  const csvc = await prisma.department.findFirstOrThrow({ where: { code: 'CSVC' } });
  const hcns = await prisma.department.findFirstOrThrow({ where: { code: 'HCNS' } });

  await prisma.user.createMany({
    data: [
      { id: 'u-sv-1', ssoSubject: 'mock:u-sv-1', email: 'u-sv-1@mock.local', displayName: 'sv-1', role: 'SV', departmentId: null },
      { id: 'u-lead-1', ssoSubject: 'mock:u-lead-1', email: 'u-lead-1@mock.local', displayName: 'lead-1', role: 'HelpdeskLead', departmentId: null },
      { id: 'u-agent-1', ssoSubject: 'mock:u-agent-1', email: 'u-agent-1@mock.local', displayName: 'agent-1', role: 'HelpdeskAgent', departmentId: null },
      { id: 'u-agent-2', ssoSubject: 'mock:u-agent-2', email: 'u-agent-2@mock.local', displayName: 'agent-2', role: 'HelpdeskAgent', departmentId: null },
      { id: 'u-staff-csvc', ssoSubject: 'mock:u-staff-csvc', email: 'u-staff-csvc@mock.local', displayName: 'staff-csvc', role: 'DeptStaff', departmentId: csvc.id },
      { id: 'u-staff-hcns', ssoSubject: 'mock:u-staff-hcns', email: 'u-staff-hcns@mock.local', displayName: 'staff-hcns', role: 'DeptStaff', departmentId: hcns.id },
    ],
    skipDuplicates: true,
  });

  return {
    csvcDeptId: csvc.id,
    hcnsDeptId: hcns.id,
    leadHeaders: mockSsoHeaders({ id: 'u-lead-1', role: 'HelpdeskLead' }),
    agent1Headers: mockSsoHeaders({ id: 'u-agent-1', role: 'HelpdeskAgent' }),
    agent2Headers: mockSsoHeaders({ id: 'u-agent-2', role: 'HelpdeskAgent' }),
    staffCsvcHeaders: mockSsoHeaders({ id: 'u-staff-csvc', role: 'DeptStaff', departmentId: csvc.id }),
    staffHcnsHeaders: mockSsoHeaders({ id: 'u-staff-hcns', role: 'DeptStaff', departmentId: hcns.id }),
    svHeaders: mockSsoHeaders({ id: 'u-sv-1', role: 'SV' }),
  };
}

let seq = 0;
function nextCode(): string {
  seq += 1;
  return `HD-2026-C${String(seq).padStart(5, '0')}`;
}

async function seedTicket(opts: {
  status?: TicketStatus;
  severity?: Severity;
  routedDepartmentId?: string | null;
  helpdeskAssigneeId?: string | null;
  closeRequestedById?: string | null;
}) {
  return prisma.ticket.create({
    data: {
      code: nextCode(),
      title: 'seeded ticket',
      description: 'seeded for close-request test',
      severity: opts.severity ?? 'Medium',
      status: opts.status ?? 'InProgress',
      requesterId: 'u-sv-1',
      routedDepartmentId: opts.routedDepartmentId ?? null,
      helpdeskAssigneeId: opts.helpdeskAssigneeId ?? null,
      closeRequestedById: opts.closeRequestedById ?? null,
    },
  });
}

/** A ticket InProgress, routed to CSVC, assigned to agent-1 — the canonical
 *  pre-condition for a DeptStaff close request. */
function inProgressCsvc(s: TestSetup) {
  return seedTicket({
    status: 'InProgress',
    routedDepartmentId: s.csvcDeptId,
    helpdeskAssigneeId: 'u-agent-1',
  });
}

describe('BE-S17 — DeptStaff close request workflow', () => {
  let s: TestSetup;

  beforeEach(async () => {
    await resetDb();
    await runSeed(prisma);
    seq = 0;
    s = await setupUsers();
  });
  afterAll(async () => {
    await disconnect();
  });

  it('M31-BE-S17-H1: DeptStaff request-close → CloseRequested, proof comment + event, notifies agent + lead', async () => {
    const t = await inProgressCsvc(s);
    const res = await request(app)
      .post(`/tickets/${t.id}/request-close`)
      .set(s.staffCsvcHeaders)
      .field('note', 'Đã thay router, kiểm tra mạng OK');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: t.id, internalStatus: 'CloseRequested' });
    // Requester still sees "Processing".
    expect(res.body.data.externalStatus).toBe('Processing');

    const stored = await prisma.ticket.findUnique({ where: { id: t.id }, select: { closeRequestedById: true } });
    expect(stored?.closeRequestedById).toBe('u-staff-csvc');

    // Proof comment created.
    const comments = await prisma.ticketComment.findMany({ where: { ticketId: t.id } });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe('Đã thay router, kiểm tra mạng OK');

    const events = await prisma.ticketEvent.findMany({ where: { ticketId: t.id, type: 'CloseRequested' } });
    expect(events).toHaveLength(1);

    // Notifies the assigned agent + the lead (not the actor).
    const agentNotif = await prisma.notification.findMany({ where: { ticketId: t.id, userId: 'u-agent-1', type: 'CloseRequested' } });
    expect(agentNotif).toHaveLength(1);
    const leadNotif = await prisma.notification.findMany({ where: { ticketId: t.id, userId: 'u-lead-1', type: 'CloseRequested' } });
    expect(leadNotif).toHaveLength(1);
  });

  it('M31-BE-S17-H2: Lead approve-close → Closed, notifies requester + the requesting staff', async () => {
    const t = await seedTicket({
      status: 'CloseRequested',
      routedDepartmentId: s.csvcDeptId,
      helpdeskAssigneeId: 'u-agent-1',
      closeRequestedById: 'u-staff-csvc',
    });
    const res = await request(app)
      .post(`/tickets/${t.id}/approve-close`)
      .set(s.leadHeaders)
      .send({ reason: 'Đã xác nhận hoàn thành' });

    expect(res.status).toBe(200);
    expect(res.body.data.internalStatus).toBe('Closed');

    const stored = await prisma.ticket.findUnique({ where: { id: t.id }, select: { closeRequestedById: true, closedAt: true } });
    expect(stored?.closeRequestedById).toBeNull();
    expect(stored?.closedAt).not.toBeNull();

    const closedEvent = await prisma.ticketEvent.findMany({ where: { ticketId: t.id, type: 'Closed' } });
    expect(closedEvent).toHaveLength(1);

    const requesterNotif = await prisma.notification.findMany({ where: { ticketId: t.id, userId: 'u-sv-1', type: 'TicketClosed' } });
    expect(requesterNotif).toHaveLength(1);
    const staffNotif = await prisma.notification.findMany({ where: { ticketId: t.id, userId: 'u-staff-csvc', type: 'TicketClosed' } });
    expect(staffNotif).toHaveLength(1);
  });

  it('M31-BE-S17-H3: the assigned Agent can approve-close', async () => {
    const t = await seedTicket({
      status: 'CloseRequested',
      routedDepartmentId: s.csvcDeptId,
      helpdeskAssigneeId: 'u-agent-1',
      closeRequestedById: 'u-staff-csvc',
    });
    const res = await request(app).post(`/tickets/${t.id}/approve-close`).set(s.agent1Headers).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.internalStatus).toBe('Closed');
  });

  it('M31-BE-S17-H4: refuse-close → back to InProgress, CloseRefused event, notifies the requesting staff', async () => {
    const t = await seedTicket({
      status: 'CloseRequested',
      routedDepartmentId: s.csvcDeptId,
      helpdeskAssigneeId: 'u-agent-1',
      closeRequestedById: 'u-staff-csvc',
    });
    const res = await request(app)
      .post(`/tickets/${t.id}/refuse-close`)
      .set(s.agent1Headers)
      .send({ reason: 'Chưa đính kèm ảnh nghiệm thu' });

    expect(res.status).toBe(200);
    expect(res.body.data.internalStatus).toBe('InProgress');

    const stored = await prisma.ticket.findUnique({ where: { id: t.id }, select: { closeRequestedById: true } });
    expect(stored?.closeRequestedById).toBeNull();

    const ev = await prisma.ticketEvent.findMany({ where: { ticketId: t.id, type: 'CloseRefused' } });
    expect(ev).toHaveLength(1);
    expect(ev[0]?.note).toBe('Chưa đính kèm ảnh nghiệm thu');

    const staffNotif = await prisma.notification.findMany({ where: { ticketId: t.id, userId: 'u-staff-csvc', type: 'CloseRefused' } });
    expect(staffNotif).toHaveLength(1);
  });

  it('M31-BE-S17-X1: request-close without a note → 422', async () => {
    const t = await inProgressCsvc(s);
    const res = await request(app).post(`/tickets/${t.id}/request-close`).set(s.staffCsvcHeaders).field('note', '   ');
    expect(res.status).toBe(422);
  });

  it('M31-BE-S17-X2: DeptStaff of the WRONG dept → 403', async () => {
    const t = await inProgressCsvc(s);
    const res = await request(app)
      .post(`/tickets/${t.id}/request-close`)
      .set(s.staffHcnsHeaders)
      .field('note', 'Xong rồi');
    expect(res.status).toBe(403);
  });

  it('M31-BE-S17-X3: request-close from a non-InProgress status → 409', async () => {
    const t = await seedTicket({ status: 'Assigned', routedDepartmentId: s.csvcDeptId });
    const res = await request(app)
      .post(`/tickets/${t.id}/request-close`)
      .set(s.staffCsvcHeaders)
      .field('note', 'Xong rồi');
    expect(res.status).toBe(409);
  });

  it('M31-BE-S17-X4: a non-DeptStaff (Agent) cannot request-close → 403', async () => {
    const t = await inProgressCsvc(s);
    const res = await request(app)
      .post(`/tickets/${t.id}/request-close`)
      .set(s.agent1Headers)
      .field('note', 'Xong rồi');
    expect(res.status).toBe(403);
  });

  it('M31-BE-S17-X5: an Agent who is NOT the assignee cannot approve-close → 403', async () => {
    const t = await seedTicket({
      status: 'CloseRequested',
      routedDepartmentId: s.csvcDeptId,
      helpdeskAssigneeId: 'u-agent-1',
      closeRequestedById: 'u-staff-csvc',
    });
    const res = await request(app).post(`/tickets/${t.id}/approve-close`).set(s.agent2Headers).send({});
    expect(res.status).toBe(403);
  });

  it('M31-BE-S17-X6: approve-close from a non-CloseRequested status → 409', async () => {
    const t = await inProgressCsvc(s);
    const res = await request(app).post(`/tickets/${t.id}/approve-close`).set(s.leadHeaders).send({});
    expect(res.status).toBe(409);
  });

  it('M31-BE-S17-X7: refuse-close without a reason → 422', async () => {
    const t = await seedTicket({
      status: 'CloseRequested',
      routedDepartmentId: s.csvcDeptId,
      helpdeskAssigneeId: 'u-agent-1',
      closeRequestedById: 'u-staff-csvc',
    });
    const res = await request(app).post(`/tickets/${t.id}/refuse-close`).set(s.leadHeaders).send({ reason: '  ' });
    expect(res.status).toBe(422);
  });

  it('M31-BE-S17-X8: SV cannot approve-close → 403', async () => {
    const t = await seedTicket({
      status: 'CloseRequested',
      routedDepartmentId: s.csvcDeptId,
      helpdeskAssigneeId: 'u-agent-1',
      closeRequestedById: 'u-staff-csvc',
    });
    const res = await request(app).post(`/tickets/${t.id}/approve-close`).set(s.svHeaders).send({});
    expect(res.status).toBe(403);
  });
});