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
  svHeaders: Record<string, string>;
  leadHeaders: Record<string, string>;
  agent1Headers: Record<string, string>;
  agent2Headers: Record<string, string>;
  staffHeaders: Record<string, string>;
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
    svHeaders: mockSsoHeaders({ id: 'u-sv-1', role: 'SV' }),
    leadHeaders: mockSsoHeaders({ id: 'u-lead-1', role: 'HelpdeskLead' }),
    agent1Headers: mockSsoHeaders({ id: 'u-agent-1', role: 'HelpdeskAgent' }),
    agent2Headers: mockSsoHeaders({ id: 'u-agent-2', role: 'HelpdeskAgent' }),
    staffHeaders: mockSsoHeaders({ id: 'u-staff-csvc', role: 'DeptStaff', departmentId: csvc.id }),
  };
}

let seq = 0;
function nextCode(): string {
  seq += 1;
  return `HD-2026-T${String(seq).padStart(5, '0')}`;
}

async function seedTicket(opts: {
  status?: TicketStatus;
  severity?: Severity;
  requesterId?: string;
  routedDepartmentId?: string | null;
  helpdeskAssigneeId?: string | null;
}) {
  return prisma.ticket.create({
    data: {
      code: nextCode(),
      title: 'seeded ticket',
      description: 'seeded for transition test',
      severity: opts.severity ?? 'Medium',
      status: opts.status ?? 'Pending',
      requesterId: opts.requesterId ?? 'u-sv-1',
      routedDepartmentId: opts.routedDepartmentId ?? null,
      helpdeskAssigneeId: opts.helpdeskAssigneeId ?? null,
    },
  });
}

describe('BE-S5 — State-machine transitions', () => {
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

  it('M31-BE-S5-H1: Lead POST /assign sets helpdeskAssigneeId, writes AgentAssigned event, notifies the agent', async () => {
    const t = await seedTicket({});
    const res = await request(app)
      .post(`/tickets/${t.id}/assign`)
      .set(s.leadHeaders)
      .send({ agentId: 'u-agent-1' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: t.id,
      helpdeskAssignee: { id: 'u-agent-1' },
      internalStatus: 'Pending',
    });

    const events = await prisma.ticketEvent.findMany({ where: { ticketId: t.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'AgentAssigned', actorId: 'u-lead-1' });

    const notifs = await prisma.notification.findMany({ where: { ticketId: t.id, userId: 'u-agent-1' } });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.type).toBe('TicketAssigned');
  });

  it('M31-BE-S5-H2: Helpdesk POST /forward moves Pending→Assigned, writes Forwarded event, notifies dept staff', async () => {
    const t = await seedTicket({});
    const res = await request(app)
      .post(`/tickets/${t.id}/forward`)
      .set(s.leadHeaders)
      .send({ departmentId: s.csvcDeptId });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: t.id,
      internalStatus: 'Assigned',
      routedDepartment: { id: s.csvcDeptId },
    });

    const ev = await prisma.ticketEvent.findMany({ where: { ticketId: t.id } });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      type: 'Forwarded',
      fromStatus: 'Pending',
      toStatus: 'Assigned',
      toDepartmentId: s.csvcDeptId,
    });

    // Forward fans out to the routed dept staff plus requester / assigned
    // agent when applicable. The dept staff notification is the load-bearing
    // one for routing — scope the assertion to that recipient.
    const staffNotifs = await prisma.notification.findMany({
      where: { ticketId: t.id, userId: 'u-staff-csvc' },
    });
    expect(staffNotifs).toHaveLength(1);
    expect(staffNotifs[0]).toMatchObject({ type: 'TicketForwarded' });
  });

  it('M31-BE-S5-H3: DeptStaff (own dept) POST /progress moves Assigned→InProgress, notifies requester', async () => {
    const t = await seedTicket({ status: 'Assigned', routedDepartmentId: s.csvcDeptId });
    const res = await request(app).post(`/tickets/${t.id}/progress`).set(s.staffHeaders).send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: t.id, internalStatus: 'InProgress' });

    const ev = await prisma.ticketEvent.findMany({ where: { ticketId: t.id } });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'Started', fromStatus: 'Assigned', toStatus: 'InProgress' });

    const notif = await prisma.notification.findFirst({ where: { ticketId: t.id, userId: 'u-sv-1' } });
    expect(notif).toMatchObject({ type: 'StatusChanged' });
  });

  it('M31-BE-S5-H4: Lead POST /close sets status=Closed, closedAt, notifies requester', async () => {
    const t = await seedTicket({ status: 'Assigned', routedDepartmentId: s.csvcDeptId });
    const res = await request(app).post(`/tickets/${t.id}/close`).set(s.leadHeaders).send({ reason: 'done' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: t.id, internalStatus: 'Closed' });
    expect(res.body.data.closedAt).toBeTruthy();

    const ev = await prisma.ticketEvent.findMany({ where: { ticketId: t.id, type: 'Closed' } });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ fromStatus: 'Assigned', toStatus: 'Closed', note: 'done' });

    const notif = await prisma.notification.findFirst({ where: { ticketId: t.id, userId: 'u-sv-1', type: 'TicketClosed' } });
    expect(notif).not.toBeNull();
  });

  it('M31-BE-S5-E1: Lead reassigns the agent — history has two AgentAssigned events; final assignee is the second', async () => {
    const t = await seedTicket({});

    const r1 = await request(app).post(`/tickets/${t.id}/assign`).set(s.leadHeaders).send({ agentId: 'u-agent-1' });
    expect(r1.status).toBe(200);

    const r2 = await request(app).post(`/tickets/${t.id}/assign`).set(s.leadHeaders).send({ agentId: 'u-agent-2' });
    expect(r2.status).toBe(200);
    expect(r2.body.data.helpdeskAssignee.id).toBe('u-agent-2');

    const ev = await prisma.ticketEvent.findMany({ where: { ticketId: t.id, type: 'AgentAssigned' }, orderBy: { createdAt: 'asc' } });
    expect(ev).toHaveLength(2);
    expect(ev[0]?.note).toBe('u-agent-1');
    expect(ev[1]?.note).toBe('u-agent-2');
  });

  it('M31-BE-S5-E3: Helpdesk PATCH /severity updates severity and writes SeverityChanged', async () => {
    const t = await seedTicket({ severity: 'High' });
    const res = await request(app)
      .patch(`/tickets/${t.id}/severity`)
      .set(s.leadHeaders)
      .send({ severity: 'Low' });

    expect(res.status).toBe(200);
    expect(res.body.data.severity).toBe('Low');

    const ev = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: t.id, type: 'SeverityChanged' } });
    expect(ev.note).toBe('High -> Low');
  });

  it('M31-BE-S5-X1: SV POST /close → 403 (close authority is Helpdesk Lead or assigned Agent)', async () => {
    const t = await seedTicket({});
    const res = await request(app).post(`/tickets/${t.id}/close`).set(s.svHeaders).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('M31-BE-S5-X2: stale-state race — two concurrent forwards on a Pending ticket; one 200, one 409, no extra event', async () => {
    const t = await seedTicket({});
    const [r1, r2] = await Promise.all([
      request(app).post(`/tickets/${t.id}/forward`).set(s.leadHeaders).send({ departmentId: s.csvcDeptId }),
      request(app).post(`/tickets/${t.id}/forward`).set(s.leadHeaders).send({ departmentId: s.hcnsDeptId }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const conflictBody = r1.status === 409 ? r1.body : r2.body;
    expect(conflictBody.error.code).toBe('conflict');

    const events = await prisma.ticketEvent.findMany({ where: { ticketId: t.id, type: 'Forwarded' } });
    expect(events).toHaveLength(1);
  });

  it('M31-BE-S5-X3: POST /progress on a Pending ticket → 409 (must be Assigned)', async () => {
    const t = await seedTicket({});
    const res = await request(app).post(`/tickets/${t.id}/progress`).set(s.staffHeaders).send({});
    // DeptStaff would also fail scope (ticket not routed to their dept), so check
    // role-passing case too — Lead can technically attempt progress on Pending.
    const r2 = await request(app).post(`/tickets/${t.id}/progress`).set(s.leadHeaders).send({});
    expect([res.status, r2.status]).toEqual(expect.arrayContaining([409]));
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('conflict');
  });

  it('M31-BE-S5-X4: POST /forward on a Closed ticket → 409', async () => {
    const t = await seedTicket({ status: 'Closed' });
    const res = await request(app)
      .post(`/tickets/${t.id}/forward`)
      .set(s.leadHeaders)
      .send({ departmentId: s.csvcDeptId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('M31-BE-S5-I1: full lifecycle — SV create → Lead assign → Lead forward → Staff progress → Lead close', async () => {
    // 1. SV create via HTTP
    const created = await request(app)
      .post('/tickets')
      .set(s.svHeaders)
      .field('title', 'Wifi hỏng phòng 502')
      .field('description', 'Hỏng từ 7h sáng')
      .field('severity', 'High');
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    // 2. Lead assign
    const r1 = await request(app).post(`/tickets/${id}/assign`).set(s.leadHeaders).send({ agentId: 'u-agent-1' });
    expect(r1.status).toBe(200);

    // 3. Lead forward to CSVC
    const r2 = await request(app).post(`/tickets/${id}/forward`).set(s.leadHeaders).send({ departmentId: s.csvcDeptId });
    expect(r2.status).toBe(200);

    // 4. Staff progress
    const r3 = await request(app).post(`/tickets/${id}/progress`).set(s.staffHeaders).send({});
    expect(r3.status).toBe(200);

    // 5. Lead close
    const r4 = await request(app).post(`/tickets/${id}/close`).set(s.leadHeaders).send({ reason: 'Đã sửa' });
    expect(r4.status).toBe(200);

    // History: Created → AgentAssigned → Forwarded → Started → Closed
    const events = await prisma.ticketEvent.findMany({
      where: { ticketId: id },
      orderBy: { createdAt: 'asc' },
    });
    const types = events.map((e) => e.type);
    expect(types).toEqual(['Created', 'AgentAssigned', 'Forwarded', 'Started', 'Closed']);

    // Notifications hit the right recipients at least once each.
    const notifTypes = await prisma.notification.findMany({
      where: { ticketId: id },
      select: { type: true, userId: true },
    });
    expect(notifTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'TicketAssigned', userId: 'u-agent-1' }),
        expect.objectContaining({ type: 'TicketForwarded', userId: 'u-staff-csvc' }),
        expect.objectContaining({ type: 'StatusChanged', userId: 'u-sv-1' }),
        expect.objectContaining({ type: 'TicketClosed', userId: 'u-sv-1' }),
      ]),
    );

    const finalTicket = await prisma.ticket.findUniqueOrThrow({ where: { id } });
    expect(finalTicket.status).toBe('Closed');
    expect(finalTicket.closedAt).not.toBeNull();
  });
});
