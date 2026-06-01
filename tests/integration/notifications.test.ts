import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';
import { mockSsoHeaders } from '../helpers/sso-headers';
import { runSeed } from '../../prisma/seed';
import { disconnect, resetDb, testPrisma as prisma } from '../helpers/test-db';

const app = createTestApp();

interface TestSetup {
  csvcDeptId: string;
  svHeaders: Record<string, string>;
  sv2Headers: Record<string, string>;
  leadHeaders: Record<string, string>;
  agent1Headers: Record<string, string>;
  staffHeaders: Record<string, string>;
}

interface ListResponse {
  data: {
    items: Array<{ id: string; type: string; userId: string; readAt: string | null; createdAt: string }>;
    page: number;
    pageSize: number;
    total: number;
    unreadCount: number;
  };
}

async function setupUsers(): Promise<TestSetup> {
  const csvc = await prisma.department.findFirstOrThrow({ where: { code: 'CSVC' } });
  await prisma.user.createMany({
    data: [
      { id: 'u-sv-1', ssoSubject: 'mock:u-sv-1', email: 'u-sv-1@mock.local', displayName: 'sv-1', role: 'SV', departmentId: null },
      { id: 'u-sv-2', ssoSubject: 'mock:u-sv-2', email: 'u-sv-2@mock.local', displayName: 'sv-2', role: 'SV', departmentId: null },
      { id: 'u-lead-1', ssoSubject: 'mock:u-lead-1', email: 'u-lead-1@mock.local', displayName: 'lead-1', role: 'HelpdeskLead', departmentId: null },
      { id: 'u-agent-1', ssoSubject: 'mock:u-agent-1', email: 'u-agent-1@mock.local', displayName: 'agent-1', role: 'HelpdeskAgent', departmentId: null },
      { id: 'u-staff-csvc', ssoSubject: 'mock:u-staff-csvc', email: 'u-staff-csvc@mock.local', displayName: 'staff-csvc', role: 'DeptStaff', departmentId: csvc.id },
    ],
    skipDuplicates: true,
  });
  return {
    csvcDeptId: csvc.id,
    svHeaders: mockSsoHeaders({ id: 'u-sv-1', role: 'SV' }),
    sv2Headers: mockSsoHeaders({ id: 'u-sv-2', role: 'SV' }),
    leadHeaders: mockSsoHeaders({ id: 'u-lead-1', role: 'HelpdeskLead' }),
    agent1Headers: mockSsoHeaders({ id: 'u-agent-1', role: 'HelpdeskAgent' }),
    staffHeaders: mockSsoHeaders({ id: 'u-staff-csvc', role: 'DeptStaff', departmentId: csvc.id }),
  };
}

let seq = 0;
function nextCode(): string {
  seq += 1;
  return `HD-2026-N${String(seq).padStart(5, '0')}`;
}

async function seedTicket(requesterId = 'u-sv-1') {
  return prisma.ticket.create({
    data: {
      code: nextCode(),
      title: 'notif test',
      description: 'notif test seed',
      severity: 'Medium',
      status: 'Pending',
      requesterId,
    },
  });
}

describe('BE-S7 — In-app notifications', () => {
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

  it('M31-BE-S7-H1: on close, TicketClosed lands in requester inbox unread, newest-first', async () => {
    const t = await seedTicket();
    await request(app).post(`/tickets/${t.id}/close`).set(s.leadHeaders).send({}).expect(200);

    const res = await request(app).get('/notifications').set(s.svHeaders);
    expect(res.status).toBe(200);
    const body = res.body as ListResponse;
    expect(body.data.total).toBe(1);
    expect(body.data.unreadCount).toBe(1);
    expect(body.data.items[0]).toMatchObject({ type: 'TicketClosed', userId: 'u-sv-1', readAt: null });
  });

  it('M31-BE-S7-E1: on assign, TicketAssigned lands in the agent inbox', async () => {
    const t = await seedTicket();
    await request(app)
      .post(`/tickets/${t.id}/assign`)
      .set(s.leadHeaders)
      .send({ agentId: 'u-agent-1' })
      .expect(200);

    const res = await request(app).get('/notifications').set(s.agent1Headers);
    const body = res.body as ListResponse;
    expect(body.data.unreadCount).toBe(1);
    expect(body.data.items[0]).toMatchObject({ type: 'TicketAssigned', userId: 'u-agent-1' });
  });

  it('M31-BE-S7-E2: on forward, every DeptStaff in the target dept gets a TicketForwarded', async () => {
    const t = await seedTicket();
    await request(app)
      .post(`/tickets/${t.id}/forward`)
      .set(s.leadHeaders)
      .send({ departmentId: s.csvcDeptId })
      .expect(200);

    const res = await request(app).get('/notifications').set(s.staffHeaders);
    const body = res.body as ListResponse;
    expect(body.data.items[0]).toMatchObject({ type: 'TicketForwarded', userId: 'u-staff-csvc' });
  });

  it('M31-BE-S7-E3: marking one read returns it but sorted after remaining unread', async () => {
    // Two notifications for SV1: close ticket A, then close ticket B.
    const tA = await seedTicket();
    const tB = await seedTicket();
    await request(app).post(`/tickets/${tA.id}/close`).set(s.leadHeaders).send({}).expect(200);
    await request(app).post(`/tickets/${tB.id}/close`).set(s.leadHeaders).send({}).expect(200);

    const before = (await request(app).get('/notifications').set(s.svHeaders)).body as ListResponse;
    expect(before.data.unreadCount).toBe(2);
    // Newest unread first → close-of-B at index 0
    const firstId = before.data.items[0]!.id;

    // Mark the first (newest unread) read.
    const marked = await request(app).post(`/notifications/${firstId}/read`).set(s.svHeaders);
    expect(marked.status).toBe(200);
    expect(marked.body.data.readAt).toBeTruthy();

    const after = (await request(app).get('/notifications').set(s.svHeaders)).body as ListResponse;
    expect(after.data.unreadCount).toBe(1);
    // The unread one comes first; the just-read one moves below it.
    expect(after.data.items[0]?.readAt).toBeNull();
    expect(after.data.items[1]?.id).toBe(firstId);
    expect(after.data.items[1]?.readAt).not.toBeNull();
  });

  it('M31-BE-S7-X1: GET /notifications scopes to the caller only', async () => {
    const t = await seedTicket('u-sv-1');
    await request(app).post(`/tickets/${t.id}/close`).set(s.leadHeaders).send({}).expect(200);

    // SV2 has no notifications even though SV1 just got one.
    const sv2 = (await request(app).get('/notifications').set(s.sv2Headers)).body as ListResponse;
    expect(sv2.data.total).toBe(0);
    expect(sv2.data.unreadCount).toBe(0);
  });

  it("M31-BE-S7-X2: POST /notifications/:id/read on another user's notification → 403", async () => {
    const t = await seedTicket('u-sv-1');
    await request(app).post(`/tickets/${t.id}/close`).set(s.leadHeaders).send({}).expect(200);

    const list = (await request(app).get('/notifications').set(s.svHeaders)).body as ListResponse;
    const notifId = list.data.items[0]!.id;

    const res = await request(app).post(`/notifications/${notifId}/read`).set(s.sv2Headers);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('M31-BE-S7-I1: end-to-end — Lead closes → requester sees + unread=1 → marks read → unread=0', async () => {
    const t = await seedTicket();
    await request(app).post(`/tickets/${t.id}/close`).set(s.leadHeaders).send({}).expect(200);

    const inbox = (await request(app).get('/notifications').set(s.svHeaders)).body as ListResponse;
    expect(inbox.data.unreadCount).toBe(1);
    const id = inbox.data.items[0]!.id;

    await request(app).post(`/notifications/${id}/read`).set(s.svHeaders).expect(200);

    const after = (await request(app).get('/notifications').set(s.svHeaders)).body as ListResponse;
    expect(after.data.unreadCount).toBe(0);
    expect(after.data.total).toBe(1);
  });
});
