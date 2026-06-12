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
    svHeaders: mockSsoHeaders({ id: 'u-sv-1', role: 'SV' }),
  };
}

let seq = 0;
function nextCode(): string {
  seq += 1;
  return `HD-2026-R${String(seq).padStart(5, '0')}`;
}

async function seedTicket(s: TestSetup, opts: { status?: TicketStatus; routedDepartmentId?: string | null; helpdeskAssigneeId?: string | null } = {}) {
  return prisma.ticket.create({
    data: {
      code: nextCode(),
      title: 'seeded ticket',
      description: 'seeded for redirect test',
      severity: 'Medium',
      status: opts.status ?? 'Assigned',
      requesterId: 'u-sv-1',
      routedDepartmentId: opts.routedDepartmentId === undefined ? s.csvcDeptId : opts.routedDepartmentId,
      helpdeskAssigneeId: opts.helpdeskAssigneeId ?? 'u-agent-1',
    },
  });
}

describe('BE-S18 — Agent/Lead direct redirect', () => {
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

  it('M31-BE-S18-H1: Lead redirects an Assigned ticket to another dept → Assigned (new dept), assignee kept, Redirected event, notifies new dept', async () => {
    const t = await seedTicket(s, { status: 'Assigned', routedDepartmentId: s.csvcDeptId });
    const res = await request(app)
      .post(`/tickets/${t.id}/redirect`)
      .set(s.leadHeaders)
      .send({ departmentId: s.hcnsDeptId, reason: 'Thuộc phạm vi HCNS' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: t.id,
      internalStatus: 'Assigned',
      routedDepartment: { id: s.hcnsDeptId },
      helpdeskAssignee: { id: 'u-agent-1' },
    });

    const ev = await prisma.ticketEvent.findMany({ where: { ticketId: t.id, type: 'Redirected' } });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ fromDepartmentId: s.csvcDeptId, toDepartmentId: s.hcnsDeptId, note: 'Thuộc phạm vi HCNS' });
  });

  it('M31-BE-S18-H2: redirecting an InProgress ticket resets it to Assigned', async () => {
    const t = await seedTicket(s, { status: 'InProgress', routedDepartmentId: s.csvcDeptId });
    const res = await request(app)
      .post(`/tickets/${t.id}/redirect`)
      .set(s.leadHeaders)
      .send({ departmentId: s.hcnsDeptId, reason: 'Sai phòng' });
    expect(res.status).toBe(200);
    expect(res.body.data.internalStatus).toBe('Assigned');
    expect(res.body.data.routedDepartment.id).toBe(s.hcnsDeptId);
  });

  it('M31-BE-S18-H3: the assigned Agent can redirect their ticket', async () => {
    const t = await seedTicket(s, { status: 'Assigned', helpdeskAssigneeId: 'u-agent-1' });
    const res = await request(app)
      .post(`/tickets/${t.id}/redirect`)
      .set(s.agent1Headers)
      .send({ departmentId: s.hcnsDeptId, reason: 'Chuyển HCNS' });
    expect(res.status).toBe(200);
  });

  it('M31-BE-S18-X1: redirect without a reason → 422', async () => {
    const t = await seedTicket(s, { status: 'Assigned' });
    const res = await request(app).post(`/tickets/${t.id}/redirect`).set(s.leadHeaders).send({ departmentId: s.hcnsDeptId, reason: '  ' });
    expect(res.status).toBe(422);
  });

  it('M31-BE-S18-X2: redirect to the same dept → 422', async () => {
    const t = await seedTicket(s, { status: 'Assigned', routedDepartmentId: s.csvcDeptId });
    const res = await request(app).post(`/tickets/${t.id}/redirect`).set(s.leadHeaders).send({ departmentId: s.csvcDeptId, reason: 'x' });
    expect(res.status).toBe(422);
  });

  it('M31-BE-S18-X3: redirect to an unknown dept → 422', async () => {
    const t = await seedTicket(s, { status: 'Assigned' });
    const res = await request(app).post(`/tickets/${t.id}/redirect`).set(s.leadHeaders).send({ departmentId: 'dep-nope', reason: 'x' });
    expect(res.status).toBe(422);
  });

  it('M31-BE-S18-X4: redirect from Pending → 409 (use forward for the first routing)', async () => {
    const t = await seedTicket(s, { status: 'Pending', routedDepartmentId: null });
    const res = await request(app).post(`/tickets/${t.id}/redirect`).set(s.leadHeaders).send({ departmentId: s.hcnsDeptId, reason: 'x' });
    expect(res.status).toBe(409);
  });

  it('M31-BE-S18-X5: an Agent who is NOT the assignee → 403', async () => {
    const t = await seedTicket(s, { status: 'Assigned', helpdeskAssigneeId: 'u-agent-1' });
    const res = await request(app).post(`/tickets/${t.id}/redirect`).set(s.agent2Headers).send({ departmentId: s.hcnsDeptId, reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('M31-BE-S18-X6: DeptStaff cannot direct-redirect → 403', async () => {
    const t = await seedTicket(s, { status: 'Assigned' });
    const res = await request(app).post(`/tickets/${t.id}/redirect`).set(s.staffCsvcHeaders).send({ departmentId: s.hcnsDeptId, reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('M31-BE-S18-X7: SV cannot redirect → 403', async () => {
    const t = await seedTicket(s, { status: 'Assigned' });
    const res = await request(app).post(`/tickets/${t.id}/redirect`).set(s.svHeaders).send({ departmentId: s.hcnsDeptId, reason: 'x' });
    expect(res.status).toBe(403);
  });
});