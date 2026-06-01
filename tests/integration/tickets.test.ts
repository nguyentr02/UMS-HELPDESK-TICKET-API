import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Severity, TicketStatus } from '@prisma/client';
import { createTestApp } from '../helpers/app-factory';
import { mockSsoHeaders } from '../helpers/sso-headers';
import { runSeed } from '../../prisma/seed';
import { disconnect, resetDb, testPrisma as prisma } from '../helpers/test-db';

const app = createTestApp();

const sv1Headers = mockSsoHeaders({ id: 'u-sv-1', role: 'SV' });
const sv2Headers = mockSsoHeaders({ id: 'u-sv-2', role: 'SV' });
const leadHeaders = mockSsoHeaders({ id: 'u-lead-1', role: 'HelpdeskLead' });

interface ListResponse {
  data: {
    items: Array<{ id: string; code: string; status: TicketStatus; requesterId: string }>;
    page: number;
    pageSize: number;
    total: number;
  };
}

async function ensureUserRow(id: string, role: 'SV' = 'SV') {
  await prisma.user.upsert({
    where: { id },
    create: {
      id,
      ssoSubject: `mock:${id}`,
      email: `${id}@mock.local`,
      displayName: id,
      role,
      departmentId: null,
    },
    update: {},
  });
}

async function seedTicket(opts: { code: string; status: TicketStatus; severity: Severity; requesterId: string }) {
  return prisma.ticket.create({
    data: {
      code: opts.code,
      title: opts.code,
      description: opts.code,
      severity: opts.severity,
      status: opts.status,
      requesterId: opts.requesterId,
    },
  });
}

describe('BE-S4 — Ticket create + list + detail', () => {
  beforeEach(async () => {
    await resetDb();
    await runSeed(prisma);
    // Reset the global sequence so codes are deterministic across tests.
    await prisma.$executeRawUnsafe(`ALTER SEQUENCE "ticket_code_seq" RESTART WITH 1`);
  });
  afterAll(async () => {
    await disconnect();
  });

  it('M31-BE-S4-H1: SV POST /tickets (multipart, severity=High, +1 file) → 201, status=Pending, Created event, one attachment', async () => {
    const res = await request(app)
      .post('/tickets')
      .set(sv1Headers)
      .field('title', 'Mạng wifi không hoạt động')
      .field('description', 'Phòng 502 không có wifi từ 7h sáng')
      .field('severity', 'High')
      .attach('attachments', Buffer.from('note content'), 'note.txt');

    expect(res.status).toBe(201);
    const t = res.body.data;
    expect(t).toMatchObject({
      title: 'Mạng wifi không hoạt động',
      severity: 'High',
      status: 'Pending',
      requesterId: 'u-sv-1',
    });
    expect(t.code).toMatch(/^HD-\d{4}-\d{6}$/);
    expect(t.attachments).toHaveLength(1);
    expect(t.attachments[0]).toMatchObject({ filename: 'note.txt', kind: 'Document' });

    const events = await prisma.ticketEvent.findMany({ where: { ticketId: t.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'Created', toStatus: 'Pending', actorId: 'u-sv-1' });
  });

  it('M31-BE-S4-E1: SV sees only their own; HelpdeskLead sees all', async () => {
    for (const headers of [sv1Headers, sv2Headers]) {
      await request(app)
        .post('/tickets')
        .set(headers)
        .field('title', 'A title goes here')
        .field('description', 'A description goes here')
        .field('severity', 'Low');
    }

    const sv1List = (await request(app).get('/tickets').set(sv1Headers)).body as ListResponse;
    expect(sv1List.data.items).toHaveLength(1);
    expect(sv1List.data.items[0]?.requesterId).toBe('u-sv-1');
    expect(sv1List.data.total).toBe(1);

    const leadList = (await request(app).get('/tickets').set(leadHeaders)).body as ListResponse;
    expect(leadList.data.items).toHaveLength(2);
    expect(leadList.data.total).toBe(2);
  });

  it('M31-BE-S4-E2: ?status=open returns the four non-Closed statuses', async () => {
    await ensureUserRow('u-sv-1');
    const statuses: TicketStatus[] = ['Pending', 'Assigned', 'InProgress', 'Redirected', 'Closed'];
    for (let i = 0; i < statuses.length; i++) {
      const status = statuses[i];
      if (!status) continue;
      await seedTicket({
        code: `HD-2026-${String(i + 1).padStart(6, '0')}`,
        status,
        severity: 'Low',
        requesterId: 'u-sv-1',
      });
    }

    const res = await request(app).get('/tickets').query({ status: 'open' }).set(leadHeaders);
    const body = res.body as ListResponse;
    expect(res.status).toBe(200);
    expect(body.data.total).toBe(4);
    const got = body.data.items.map((t) => t.status).sort();
    expect(got).toEqual(['Assigned', 'InProgress', 'Pending', 'Redirected']);
  });

  it('M31-BE-S4-E3: ?status=Pending,Assigned + ?severity=Critical,High narrows to the intersection', async () => {
    await ensureUserRow('u-sv-1');
    const rows = [
      { code: 'HD-2026-000001', status: 'Pending', severity: 'Critical' },
      { code: 'HD-2026-000002', status: 'Pending', severity: 'Low' },        // severity excluded
      { code: 'HD-2026-000003', status: 'Assigned', severity: 'High' },
      { code: 'HD-2026-000004', status: 'Closed', severity: 'Critical' },    // status excluded
      { code: 'HD-2026-000005', status: 'InProgress', severity: 'High' },    // status excluded
    ] satisfies Array<{ code: string; status: TicketStatus; severity: Severity }>;
    for (const r of rows) {
      await seedTicket({ ...r, requesterId: 'u-sv-1' });
    }

    const res = await request(app)
      .get('/tickets')
      .query({ status: 'Pending,Assigned', severity: 'Critical,High' })
      .set(leadHeaders);
    const body = res.body as ListResponse;
    expect(res.status).toBe(200);
    expect(body.data.total).toBe(2);
    const codes = body.data.items.map((t) => t.code).sort();
    expect(codes).toEqual(['HD-2026-000001', 'HD-2026-000003']);
  });

  it('M31-BE-S4-E4: pagination page=2&pageSize=2 → items length 2; total is the unpaged count', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/tickets')
        .set(sv1Headers)
        .field('title', `Title ${i}`)
        .field('description', `Description ${i}`)
        .field('severity', 'Low');
    }
    const res = await request(app).get('/tickets').query({ page: 2, pageSize: 2 }).set(sv1Headers);
    const body = res.body as ListResponse;
    expect(res.status).toBe(200);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.total).toBe(5);
    expect(body.data.page).toBe(2);
    expect(body.data.pageSize).toBe(2);
  });

  it('M31-BE-S4-X1: POST /tickets missing severity → 422 fields.severity', async () => {
    const res = await request(app)
      .post('/tickets')
      .set(sv1Headers)
      .field('title', 'A title here')
      .field('description', 'A description here');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.fields?.severity).toBeTruthy();
  });

  it('M31-BE-S4-X2: POST /tickets with a 12MB attachment → 413 payload_too_large', async () => {
    const big = Buffer.alloc(12 * 1024 * 1024);
    const res = await request(app)
      .post('/tickets')
      .set(sv1Headers)
      .field('title', 'Big upload')
      .field('description', 'Twelve megabyte file')
      .field('severity', 'Low')
      .attach('attachments', big, 'big.bin');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it("M31-BE-S4-X3: SV2 GET /tickets/:id of SV1's ticket → 403 (server-side scoping)", async () => {
    const created = await request(app)
      .post('/tickets')
      .set(sv1Headers)
      .field('title', 'SV1 only')
      .field('description', 'private ticket')
      .field('severity', 'Low');
    const id = created.body.data.id as string;

    const res = await request(app).get(`/tickets/${id}`).set(sv2Headers);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it("M31-BE-S4-I1: SV creates → SV lists (sees it) → another SV doesn't → Lead lists (sees)", async () => {
    const created = await request(app)
      .post('/tickets')
      .set(sv1Headers)
      .field('title', 'cross-scope check')
      .field('description', 'visibility scoping test')
      .field('severity', 'Medium');
    expect(created.status).toBe(201);

    const sv1 = (await request(app).get('/tickets').set(sv1Headers)).body as ListResponse;
    expect(sv1.data.total).toBe(1);

    const sv2 = (await request(app).get('/tickets').set(sv2Headers)).body as ListResponse;
    expect(sv2.data.total).toBe(0);

    const lead = (await request(app).get('/tickets').set(leadHeaders)).body as ListResponse;
    expect(lead.data.total).toBe(1);
  });
});
