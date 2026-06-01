import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';
import { mockSsoHeaders } from '../helpers/sso-headers';
import { runSeed } from '../../prisma/seed';
import { disconnect, resetDb, testPrisma as prisma } from '../helpers/test-db';
import { setPublisher } from '../../src/lib/events/publisher';
import { EventRecorder } from '../helpers/event-recorder';

const app = createTestApp();
const svHeaders = mockSsoHeaders({ id: 'u-sv-1', role: 'SV' });
const leadHeaders = mockSsoHeaders({ id: 'u-lead-1', role: 'HelpdeskLead' });

async function seedUsers() {
  await prisma.user.createMany({
    data: [
      { id: 'u-sv-1', ssoSubject: 'mock:u-sv-1', email: 'u-sv-1@mock.local', displayName: 'sv-1', role: 'SV', departmentId: null },
      { id: 'u-lead-1', ssoSubject: 'mock:u-lead-1', email: 'u-lead-1@mock.local', displayName: 'lead-1', role: 'HelpdeskLead', departmentId: null },
    ],
    skipDuplicates: true,
  });
}

describe('BE-S9 — EventPublisher (logger adapter wired via setPublisher)', () => {
  let recorder: EventRecorder;

  beforeEach(async () => {
    await resetDb();
    await runSeed(prisma);
    await seedUsers();
    recorder = new EventRecorder();
    setPublisher(recorder);
  });

  afterEach(() => {
    setPublisher(null);
  });

  afterAll(async () => {
    await disconnect();
  });

  it('M31-BE-S9-H1: POST /tickets calls ticketCreated with { ticketId, code, severity, requesterId, createdAt }', async () => {
    const res = await request(app)
      .post('/tickets')
      .set(svHeaders)
      .field('title', 'Wifi không hoạt động')
      .field('description', 'Phòng 502 mất mạng từ sáng')
      .field('severity', 'High');
    expect(res.status).toBe(201);

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0]!;
    expect(call.method).toBe('ticketCreated');
    expect(call.event).toMatchObject({
      type: 'ticketCreated',
      ticketId: res.body.data.id,
      code: res.body.data.code,
      severity: 'High',
      requesterId: 'u-sv-1',
    });
    expect(call.event).toHaveProperty('createdAt');
  });

  it('M31-BE-S9-E1: publisher throwing does NOT roll back the ticket tx — API still 201', async () => {
    recorder.alwaysFail = true;
    const res = await request(app)
      .post('/tickets')
      .set(svHeaders)
      .field('title', 'Ticket sống sót khi publish lỗi')
      .field('description', 'publisher always throws')
      .field('severity', 'Low');
    expect(res.status).toBe(201);

    // The ticket was persisted even though publish failed.
    const persisted = await prisma.ticket.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(persisted.status).toBe('Pending');
    expect(recorder.calls).toHaveLength(0); // failures aren't recorded
  });

  it('M31-BE-S9-E2: transient failure on attempt 1 + success on attempt 2 → exactly one downstream emission', async () => {
    recorder.failNext = 1; // throw once, then succeed
    const res = await request(app)
      .post('/tickets')
      .set(svHeaders)
      .field('title', 'Retry test')
      .field('description', 'one transient fail then ok')
      .field('severity', 'Medium');
    expect(res.status).toBe(201);

    // Two attempts total (1 fail + 1 success); successful emission count = 1.
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.method).toBe('ticketCreated');
  });

  it('M31-BE-S9-X2: synchronous publisher throw is caught at the EventPublisher boundary; no error propagates', async () => {
    // alwaysFail throws on every attempt — both retries blow up.
    recorder.alwaysFail = true;
    const res = await request(app)
      .post('/tickets')
      .set(svHeaders)
      .field('title', 'Sync throw safety')
      .field('description', 'all attempts throw')
      .field('severity', 'Low');
    expect(res.status).toBe(201); // not 500
    expect(res.body.error).toBeNull();
    expect(res.body.data).toBeTruthy();
  });

  it('M31-BE-S9-I1: Lead closes → publisher receives ticketClosed with the matching ticket', async () => {
    // Create a ticket first (this will fire ticketCreated → drains the recorder).
    const created = await request(app)
      .post('/tickets')
      .set(svHeaders)
      .field('title', 'Close-publish test')
      .field('description', 'will be closed by Lead')
      .field('severity', 'Medium');
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    // Reset recorder so we measure only the close emission.
    recorder.calls = [];

    const closed = await request(app)
      .post(`/tickets/${id}/close`)
      .set(leadHeaders)
      .send({ reason: 'fixed' });
    expect(closed.status).toBe(200);

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0]!;
    expect(call.method).toBe('ticketClosed');
    expect(call.event).toMatchObject({
      type: 'ticketClosed',
      ticketId: id,
      status: 'Closed',
      requesterId: 'u-sv-1',
    });
    expect(call.event).toHaveProperty('closedAt');
  });
});
