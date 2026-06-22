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
  svHeaders: Record<string, string>;
  sv2Headers: Record<string, string>;
  leadHeaders: Record<string, string>;
  agent1Headers: Record<string, string>;
  staffHeaders: Record<string, string>;
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
  return `HD-2026-C${String(seq).padStart(5, '0')}`;
}

async function seedTicket(opts: {
  status?: TicketStatus;
  severity?: Severity;
  requesterId?: string;
  routedDepartmentId?: string | null;
}) {
  return prisma.ticket.create({
    data: {
      code: nextCode(),
      title: 'seeded ticket',
      description: 'comment test seed',
      severity: opts.severity ?? 'Medium',
      status: opts.status ?? 'Pending',
      requesterId: opts.requesterId ?? 'u-sv-1',
      routedDepartmentId: opts.routedDepartmentId ?? null,
    },
  });
}

describe('BE-S6 — Comments + attachments', () => {
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

  it('M31-BE-S6-H1: Requester POST /:id/comments { body } → 201 comment DTO; TicketEvent[Commented] appended', async () => {
    const t = await seedTicket({});
    const res = await request(app)
      .post(`/tickets/${t.id}/comments`)
      .set(s.svHeaders)
      .field('body', 'Đã thử restart router');

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      ticketId: t.id,
      author: { id: 'u-sv-1' },
      body: 'Đã thử restart router',
    });
    expect(res.body.data.attachments).toEqual([]);

    const events = await prisma.ticketEvent.findMany({
      where: { ticketId: t.id, type: 'Commented' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorId).toBe('u-sv-1');
  });

  it('M31-BE-S6-E1: DeptStaff of the routed dept can comment → 201', async () => {
    const t = await seedTicket({ status: 'Assigned', routedDepartmentId: s.csvcDeptId });
    const res = await request(app)
      .post(`/tickets/${t.id}/comments`)
      .set(s.staffHeaders)
      .field('body', 'Phòng CSVC đang kiểm tra');
    expect(res.status).toBe(201);
    expect(res.body.data.author.id).toBe('u-staff-csvc');
  });

  it('M31-BE-S6-E2: comment with an image attachment → Attachment.commentId set; GET /attachments/{id} returns the file', async () => {
    const t = await seedTicket({});
    // Real PNG magic bytes so the upload content-sniffer accepts it.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fake-png-bytes'),
    ]);

    const post = await request(app)
      .post(`/tickets/${t.id}/comments`)
      .set(s.svHeaders)
      .field('body', 'Ảnh modem')
      .attach('attachments', png, { filename: 'modem.png', contentType: 'image/png' });

    expect(post.status).toBe(201);
    const attachment = post.body.data.attachments?.[0];
    expect(attachment).toMatchObject({
      ticketId: t.id,
      commentId: post.body.data.id,
      filename: 'modem.png',
      mimeType: 'image/png',
      kind: 'Image',
    });

    const download = await request(app).get(`/attachments/${attachment.id}`).set(s.svHeaders);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/image\/png/);
  });

  it('M31-BE-S6-X1: a non-participant (other SV) POST /:id/comments → 403', async () => {
    const t = await seedTicket({}); // requester = u-sv-1
    const res = await request(app)
      .post(`/tickets/${t.id}/comments`)
      .set(s.sv2Headers)
      .field('body', 'outsider trying to comment');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('M31-BE-S6-X2: empty body → 422 fields.body', async () => {
    const t = await seedTicket({});
    const res = await request(app)
      .post(`/tickets/${t.id}/comments`)
      .set(s.svHeaders)
      .field('body', '   ');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.fields?.body).toBeTruthy();
  });

  it('M31-BE-S6-I1: GET /:id/history returns events in createdAt order: Created → AgentAssigned → Forwarded → Commented', async () => {
    // Full mini-lifecycle ending in a comment.
    const created = await request(app)
      .post('/tickets')
      .set(s.svHeaders)
      .field('title', 'Phòng 502 không có wifi')
      .field('description', 'Mất mạng từ sáng')
      .field('severity', 'High');
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const assign = await request(app)
      .post(`/tickets/${id}/assign`)
      .set(s.leadHeaders)
      .send({ agentId: 'u-agent-1' });
    expect(assign.status).toBe(200);

    const forward = await request(app)
      .post(`/tickets/${id}/forward`)
      .set(s.leadHeaders)
      .send({ departmentId: s.csvcDeptId });
    expect(forward.status).toBe(200);

    const comment = await request(app)
      .post(`/tickets/${id}/comments`)
      .set(s.staffHeaders)
      .field('body', 'Đang đến phòng kiểm tra');
    expect(comment.status).toBe(201);

    const history = await request(app).get(`/tickets/${id}/history`).set(s.svHeaders);
    expect(history.status).toBe(200);
    const types = (history.body.data as Array<{ type: string }>).map((e) => e.type);
    expect(types).toEqual(['Created', 'AgentAssigned', 'Forwarded', 'Commented']);
  });
});
