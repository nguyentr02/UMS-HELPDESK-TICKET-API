import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';
import { mockSsoHeaders } from '../helpers/sso-headers';
import { disconnect, resetDb, testPrisma } from '../helpers/test-db';
import { runSeed } from '../../prisma/seed';

const app = createTestApp();
const adminHeaders = mockSsoHeaders({ id: 'u-admin', role: 'Admin' });

describe('BE-S13 — Admin user directory', () => {
  beforeAll(async () => {
    await resetDb();
    await runSeed(testPrisma);
  });
  afterAll(async () => {
    await disconnect();
  });

  it('M31-BE-S13-H1: Admin GET /users → list of every seeded persona', async () => {
    const res = await request(app).get('/users').set(adminHeaders);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.total).toBeGreaterThanOrEqual(13);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    // DTO shape — explicit allow-list.
    const sample = res.body.data.items[0];
    expect(Object.keys(sample).sort()).toEqual(['department', 'displayName', 'email', 'id', 'role']);
  });

  it('M31-BE-S13-H2: ?role=DeptStaff filters to only DeptStaff rows', async () => {
    const res = await request(app).get('/users').query({ role: 'DeptStaff' }).set(adminHeaders);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    for (const u of res.body.data.items) expect(u.role).toBe('DeptStaff');
  });

  it('M31-BE-S13-H3: ?search=admin matches displayName OR email (case-insensitive)', async () => {
    const res = await request(app).get('/users').query({ search: 'admin' }).set(adminHeaders);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    for (const u of res.body.data.items) {
      const hay = `${u.displayName} ${u.email}`.toLowerCase();
      expect(hay.includes('admin')).toBe(true);
    }
  });

  it('M31-BE-S13-H4: pagination — pageSize=2 + page=2 returns a different slice', async () => {
    const page1 = await request(app)
      .get('/users')
      .query({ pageSize: 2, page: 1 })
      .set(adminHeaders);
    const page2 = await request(app)
      .get('/users')
      .query({ pageSize: 2, page: 2 })
      .set(adminHeaders);
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect(page1.body.data.items).toHaveLength(2);
    expect(page2.body.data.items).toHaveLength(2);
    const ids1 = page1.body.data.items.map((u: { id: string }) => u.id);
    const ids2 = page2.body.data.items.map((u: { id: string }) => u.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it('M31-BE-S13-H5: GET /users/:id → the single record', async () => {
    const res = await request(app).get('/users/u-admin').set(adminHeaders);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('u-admin');
    expect(res.body.data.role).toBe('Admin');
  });

  it('M31-BE-S13-X1: SV → 403 forbidden on list', async () => {
    const res = await request(app)
      .get('/users')
      .set(mockSsoHeaders({ id: 'u-sv-1', role: 'SV' }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('M31-BE-S13-X2: HelpdeskLead → 403 (Admin-only)', async () => {
    const res = await request(app)
      .get('/users')
      .set(mockSsoHeaders({ id: 'u-hdl', role: 'HelpdeskLead' }));
    expect(res.status).toBe(403);
  });

  it('M31-BE-S13-X3: GET /users/:id with unknown id → 404', async () => {
    const res = await request(app).get('/users/u-does-not-exist').set(adminHeaders);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('M31-BE-S13-X4: ?role=Invalid → 422 validation_error', async () => {
    const res = await request(app).get('/users').query({ role: 'Wizard' }).set(adminHeaders);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('M31-BE-S13-X5: response never includes passwordHash / ssoSubject / googleId / avatarUrl', async () => {
    const list = await request(app).get('/users').query({ pageSize: 100 }).set(adminHeaders);
    expect(list.status).toBe(200);
    for (const u of list.body.data.items) {
      expect(Object.keys(u)).not.toContain('passwordHash');
      expect(Object.keys(u)).not.toContain('ssoSubject');
      expect(Object.keys(u)).not.toContain('googleId');
      expect(Object.keys(u)).not.toContain('avatarUrl');
    }
    const detail = await request(app).get('/users/u-admin').set(adminHeaders);
    expect(Object.keys(detail.body.data)).not.toContain('passwordHash');
    expect(Object.keys(detail.body.data)).not.toContain('ssoSubject');
    expect(Object.keys(detail.body.data)).not.toContain('googleId');
    expect(Object.keys(detail.body.data)).not.toContain('avatarUrl');
  });
});
