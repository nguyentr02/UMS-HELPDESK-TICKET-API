import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TicketStatus } from '@prisma/client';
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
  return `HD-2026-RR${String(seq).padStart(4, '0')}`;
}

async function seedTicket(s: TestSetup, opts: { status?: TicketStatus; routedDepartmentId?: string | null; redirectRequestedById?: string | null } = {}) {
  return prisma.ticket.create({
    data: {
      code: nextCode(),
      title: 'seeded ticket',
      description: 'seeded for redirect-request test',
      severity: 'Medium',
      status: opts.status ?? 'InProgress',
      requesterId: 'u-sv-1',
      routedDepartmentId: opts.routedDepartmentId === undefined ? s.csvcDeptId : opts.routedDepartmentId,
      helpdeskAssigneeId: 'u-agent-1',
      redirectRequestedById: opts.redirectRequestedById ?? null,
    },
  });
}

/** Seed a ticket already in RedirectRequested, with a prior RedirectRequested
 *  event so refuse can restore the original status. */
async function seedPending(s: TestSetup, fromStatus: TicketStatus = 'InProgress') {
  const t = await seedTicket(s, { status: 'RedirectRequested', redirectRequestedById: 'u-staff-csvc' });
  await prisma.ticketEvent.create({
    data: { ticketId: t.id, actorId: 'u-staff-csvc', type: 'RedirectRequested', fromStatus, toStatus: 'RedirectRequested', note: 'xin chuyển' },
  });
  return t;
}

describe('BE-S19 — DeptStaff redirect request workflow', () => {
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

  it('M31-BE-S19-H1: DeptStaff request-redirect → RedirectRequested, event + records who asked, notifies agent + lead', async () => {
    const t = await seedTicket(s, { status: 'InProgress', routedDepartmentId: s.csvcDeptId });
    const res = await request(app).post(`/tickets/${t.id}/request-redirect`).set(s.staffCsvcHeaders).send({ reason: 'Không thuộc phòng tôi' });

    expect(res.status).toBe(200);
    expect(res.body.data.internalStatus).toBe('RedirectRequested');
    expect(res.body.data.externalStatus).toBe('Processing');

    const stored = await prisma.ticket.findUnique({ where: { id: t.id }, select: { redirectRequestedById: true } });
    expect(stored?.redirectRequestedById).toBe('u-staff-csvc');

    const ev = await prisma.ticketEvent.findMany({ where: { ticketId: t.id, type: 'RedirectRequested' } });
    expect(ev).toHaveLength(1);
    expect(ev[0]?.note).toBe('Không thuộc phòng tôi');

    expect(await prisma.notification.count({ where: { ticketId: t.id, userId: 'u-agent-1', type: 'RedirectRequested' } })).toBe(1);
    expect(await prisma.notification.count({ where: { ticketId: t.id, userId: 'u-lead-1', type: 'RedirectRequested' } })).toBe(1);
  });

  it('M31-BE-S19-H2: Lead approve-redirect picks the target dept → Assigned (new dept), assignee kept, notifies new dept + requesting staff', async () => {
    const t = await seedPending(s, 'InProgress');
    const res = await request(app).post(`/tickets/${t.id}/approve-redirect`).set(s.leadHeaders).send({ departmentId: s.hcnsDeptId, note: 'Đúng HCNS' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ internalStatus: 'Assigned', routedDepartment: { id: s.hcnsDeptId }, helpdeskAssignee: { id: 'u-agent-1' } });

    const stored = await prisma.ticket.findUnique({ where: { id: t.id }, select: { redirectRequestedById: true } });
    expect(stored?.redirectRequestedById).toBeNull();
    expect(await prisma.ticketEvent.count({ where: { ticketId: t.id, type: 'Redirected' } })).toBe(1);
    expect(await prisma.notification.count({ where: { ticketId: t.id, userId: 'u-staff-hcns', type: 'TicketForwarded' } })).toBe(1);
    expect(await prisma.notification.count({ where: { ticketId: t.id, userId: 'u-staff-csvc', type: 'StatusChanged' } })).toBe(1);
  });

  it('M31-BE-S19-H3: refuse-redirect → back to the prior status (InProgress), CloseRefused-style event, notifies staff', async () => {
    const t = await seedPending(s, 'InProgress');
    const res = await request(app).post(`/tickets/${t.id}/refuse-redirect`).set(s.agent1Headers).send({ reason: 'Đúng phòng bạn rồi' });

    expect(res.status).toBe(200);
    expect(res.body.data.internalStatus).toBe('InProgress');
    expect(await prisma.ticketEvent.count({ where: { ticketId: t.id, type: 'RedirectRefused' } })).toBe(1);
    expect(await prisma.notification.count({ where: { ticketId: t.id, userId: 'u-staff-csvc', type: 'RedirectRefused' } })).toBe(1);
  });

  it('M31-BE-S19-H4: refuse-redirect restores Assigned when the request came from Assigned', async () => {
    const t = await seedPending(s, 'Assigned');
    const res = await request(app).post(`/tickets/${t.id}/refuse-redirect`).set(s.leadHeaders).send({ reason: 'không cần chuyển' });
    expect(res.status).toBe(200);
    expect(res.body.data.internalStatus).toBe('Assigned');
  });

  it('M31-BE-S19-X1: request-redirect without a reason → 422', async () => {
    const t = await seedTicket(s, { status: 'InProgress' });
    const res = await request(app).post(`/tickets/${t.id}/request-redirect`).set(s.staffCsvcHeaders).send({ reason: '  ' });
    expect(res.status).toBe(422);
  });

  it('M31-BE-S19-X2: DeptStaff of the wrong dept → 403', async () => {
    const t = await seedTicket(s, { status: 'InProgress', routedDepartmentId: s.csvcDeptId });
    const res = await request(app).post(`/tickets/${t.id}/request-redirect`).set(s.staffHcnsHeaders).send({ reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('M31-BE-S19-X3: request-redirect from a non-active status (Pending) → 409', async () => {
    const t = await seedTicket(s, { status: 'Pending', routedDepartmentId: s.csvcDeptId });
    const res = await request(app).post(`/tickets/${t.id}/request-redirect`).set(s.staffCsvcHeaders).send({ reason: 'x' });
    expect(res.status).toBe(409);
  });

  it('M31-BE-S19-X4: approve-redirect to the same dept → 422', async () => {
    const t = await seedPending(s);
    const res = await request(app).post(`/tickets/${t.id}/approve-redirect`).set(s.leadHeaders).send({ departmentId: s.csvcDeptId });
    expect(res.status).toBe(422);
  });

  it('M31-BE-S19-X5: a non-assignee Agent cannot approve-redirect → 403', async () => {
    const t = await seedPending(s);
    const res = await request(app).post(`/tickets/${t.id}/approve-redirect`).set(s.agent2Headers).send({ departmentId: s.hcnsDeptId });
    expect(res.status).toBe(403);
  });

  it('M31-BE-S19-X6: approve-redirect from a non-RedirectRequested status → 409', async () => {
    const t = await seedTicket(s, { status: 'InProgress' });
    const res = await request(app).post(`/tickets/${t.id}/approve-redirect`).set(s.leadHeaders).send({ departmentId: s.hcnsDeptId });
    expect(res.status).toBe(409);
  });

  it('M31-BE-S19-X7: refuse-redirect without a reason → 422', async () => {
    const t = await seedPending(s);
    const res = await request(app).post(`/tickets/${t.id}/refuse-redirect`).set(s.leadHeaders).send({ reason: '' });
    expect(res.status).toBe(422);
  });

  it('M31-BE-S19-X8: SV cannot request-redirect → 403', async () => {
    const t = await seedTicket(s, { status: 'InProgress' });
    const res = await request(app).post(`/tickets/${t.id}/request-redirect`).set(s.svHeaders).send({ reason: 'x' });
    expect(res.status).toBe(403);
  });
});