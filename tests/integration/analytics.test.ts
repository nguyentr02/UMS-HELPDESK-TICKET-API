import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Severity, TicketStatus } from '@prisma/client';
import { createTestApp } from '../helpers/app-factory';
import { mockSsoHeaders } from '../helpers/sso-headers';
import { runSeed } from '../../prisma/seed';
import { disconnect, resetDb, testPrisma as prisma } from '../helpers/test-db';
import { prisma as srcPrisma } from '../../src/lib/prisma';

const app = createTestApp();
const leadHeaders = mockSsoHeaders({ id: 'u-lead-1', role: 'HelpdeskLead' });
const adminHeaders = mockSsoHeaders({ id: 'u-admin-1', role: 'Admin' });
const svHeaders = mockSsoHeaders({ id: 'u-sv-1', role: 'SV' });

let seq = 0;
function nextCode(): string {
  seq += 1;
  return `HD-2026-AN${String(seq).padStart(5, '0')}`;
}

async function ensureRequester() {
  await prisma.user.upsert({
    where: { id: 'u-sv-1' },
    create: { id: 'u-sv-1', ssoSubject: 'mock:u-sv-1', email: 'u-sv-1@mock.local', displayName: 'sv-1', role: 'SV', departmentId: null },
    update: {},
  });
}

async function seedTicket(opts: {
  status?: TicketStatus;
  severity?: Severity;
  categoryId?: string | null;
  routedDepartmentId?: string | null;
  createdAt?: Date;
  closedAt?: Date | null;
}) {
  await ensureRequester();
  return prisma.ticket.create({
    data: {
      code: nextCode(),
      title: 'analytics seed',
      description: 'seed',
      severity: opts.severity ?? 'Medium',
      status: opts.status ?? 'Pending',
      requesterId: 'u-sv-1',
      categoryId: opts.categoryId ?? null,
      routedDepartmentId: opts.routedDepartmentId ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.closedAt !== undefined ? { closedAt: opts.closedAt } : {}),
    },
  });
}

describe('BE-S10 — Analytics summary', () => {
  beforeEach(async () => {
    await resetDb();
    await runSeed(prisma);
    seq = 0;
  });

  afterEach(() => {
    // Cleanly drop any spies before the next test; without this, a leaked spy
    // on Prisma's proxy delegate can still throw in subsequent tests.
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await disconnect();
  });

  it('M31-BE-S10-H1: Lead GET /analytics/summary returns the expected envelope shape', async () => {
    const res = await request(app).get('/analytics/summary').set(leadHeaders);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      total: expect.any(Number),
      open: expect.any(Number),
      closed: expect.any(Number),
      bySeverity: expect.any(Object),
      byStatus: expect.any(Object),
      byDepartment: expect.any(Array),
      byCategory: expect.any(Array),
    });
    expect(res.body.data).toHaveProperty('avgHandlingDays'); // may be null
  });

  it('M31-BE-S10-E1: empty DB → all counts zero, avgHandlingDays is null', async () => {
    const res = await request(app).get('/analytics/summary').set(leadHeaders);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      total: 0,
      open: 0,
      closed: 0,
      avgHandlingDays: null,
      bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0 },
      byStatus: { Pending: 0, Assigned: 0, InProgress: 0, Closed: 0 },
      byDepartment: [],
      byCategory: [],
    });
  });

  it('M31-BE-S10-E2: 3 Closed + 4 open → closed=3, open=4; byStatus splits accordingly', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    for (let i = 0; i < 3; i++) {
      await seedTicket({
        status: 'Closed',
        severity: 'Low',
        createdAt: new Date(now.getTime() - 2 * 86_400_000),
        closedAt: now,
      });
    }
    for (let i = 0; i < 4; i++) {
      await seedTicket({ status: 'Pending', severity: 'Medium' });
    }

    const res = await request(app).get('/analytics/summary').set(leadHeaders);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(7);
    expect(res.body.data.closed).toBe(3);
    expect(res.body.data.open).toBe(4);

    const byStatus = res.body.data.byStatus as Record<string, number>;
    expect(byStatus.Closed).toBe(3);
    expect(byStatus.Pending).toBe(4);

    // avgHandlingDays = 2 days for all 3 closed tickets → exactly 2.
    expect(res.body.data.avgHandlingDays).toBeCloseTo(2, 5);
  });

  it('M31-BE-S10-X1: SV → 403 (not in the allow-list)', async () => {
    const res = await request(app).get('/analytics/summary').set(svHeaders);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('M31-BE-S10-I1: 5 tickets across 2 categories, 3 departments, 2 severities → exact counts', async () => {
    const csvc = await prisma.department.findFirstOrThrow({ where: { code: 'CSVC' } });
    const hcns = await prisma.department.findFirstOrThrow({ where: { code: 'HCNS' } });
    const kt = await prisma.department.findFirstOrThrow({ where: { code: 'KT' } });
    const catIT = await prisma.category.findFirstOrThrow({ where: { name: 'IT / Hệ thống số' } });
    const catCSVC = await prisma.category.findFirstOrThrow({ where: { name: 'Cơ sở vật chất (CSVC)' } });

    // 5 tickets:
    //  - 2 High, 3 Medium    (2 severities)
    //  - 3 in cat IT, 2 in cat CSVC (2 categories)
    //  - 2 routed to CSVC, 2 to HCNS, 1 to KT  (3 departments)
    await seedTicket({ severity: 'High', categoryId: catIT.id, routedDepartmentId: csvc.id, status: 'Assigned' });
    await seedTicket({ severity: 'High', categoryId: catIT.id, routedDepartmentId: hcns.id, status: 'Assigned' });
    await seedTicket({ severity: 'Medium', categoryId: catIT.id, routedDepartmentId: kt.id, status: 'Pending' });
    await seedTicket({ severity: 'Medium', categoryId: catCSVC.id, routedDepartmentId: csvc.id, status: 'Pending' });
    await seedTicket({ severity: 'Medium', categoryId: catCSVC.id, routedDepartmentId: hcns.id, status: 'InProgress' });

    const res = await request(app).get('/analytics/summary').set(adminHeaders);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(5);

    const bySev = res.body.data.bySeverity as Record<string, number>;
    expect(bySev.High).toBe(2);
    expect(bySev.Medium).toBe(3);

    const byCat = res.body.data.byCategory as Array<{
      categoryId: string;
      name: string;
      count: number;
    }>;
    expect(byCat.find((b) => b.categoryId === catIT.id)?.count).toBe(3);
    expect(byCat.find((b) => b.categoryId === catCSVC.id)?.count).toBe(2);
    expect(byCat.find((b) => b.categoryId === catIT.id)?.name).toBe(catIT.name);

    const byDept = res.body.data.byDepartment as Array<{
      departmentId: string;
      name: string;
      count: number;
    }>;
    expect(byDept.find((b) => b.departmentId === csvc.id)?.count).toBe(2);
    expect(byDept.find((b) => b.departmentId === hcns.id)?.count).toBe(2);
    expect(byDept.find((b) => b.departmentId === kt.id)?.count).toBe(1);
    expect(byDept.find((b) => b.departmentId === csvc.id)?.name).toBe(csvc.name);
  });

  it('M31-BE-S10-X2: aggregation pipeline failure → 500 with error.code="analytics_failed" (no stack leaked)', async () => {
    vi.spyOn(srcPrisma.ticket, 'count').mockRejectedValueOnce(new Error('boom'));

    const res = await request(app).get('/analytics/summary').set(leadHeaders);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('analytics_failed');
    // No stack / no internal Prisma details leaked into the response.
    expect(JSON.stringify(res.body)).not.toMatch(/boom/);
    expect(JSON.stringify(res.body)).not.toMatch(/Prisma/);
  });
});
