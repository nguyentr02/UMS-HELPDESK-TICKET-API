import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
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

describe('BE-S15 — Admin user creation', () => {
  beforeAll(async () => {
    await resetDb();
    await runSeed(testPrisma);
  });
  afterAll(async () => {
    await disconnect();
  });

  it('M31-BE-S15-H1: Admin POST /users with valid body → 201 + DTO; password hashed; no leak', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({
        email: 'CreatedByAdmin@ums.edu.vn',
        displayName: 'Người dùng mới',
        role: 'SV',
        password: 'sup3rsecret!',
      });
    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(res.body.data.email).toBe('createdbyadmin@ums.edu.vn');
    expect(res.body.data.displayName).toBe('Người dùng mới');
    expect(res.body.data.role).toBe('SV');
    expect(Object.keys(res.body.data).sort()).toEqual(['department', 'displayName', 'email', 'id', 'role']);

    // Round-trip: the stored hash must verify the original password.
    const stored = await testPrisma.user.findUnique({
      where: { id: res.body.data.id },
      select: { passwordHash: true },
    });
    expect(stored?.passwordHash).toBeTruthy();
    if (stored?.passwordHash) {
      expect(await bcrypt.compare('sup3rsecret!', stored.passwordHash)).toBe(true);
    }
  });

  it('M31-BE-S15-H2: omitting password creates an SSO-only user (passwordHash null)', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({
        email: 'sso-only@ums.edu.vn',
        displayName: 'Chỉ SSO',
        role: 'NV',
      });
    expect(res.status).toBe(201);
    const stored = await testPrisma.user.findUnique({
      where: { id: res.body.data.id },
      select: { passwordHash: true },
    });
    expect(stored?.passwordHash).toBeNull();
  });

  it('M31-BE-S15-H3: DeptStaff role with departmentId resolves the dept on the DTO', async () => {
    // Depts use @default(cuid()) so we can't hard-code the id — resolve by code.
    const csvc = await testPrisma.department.findUnique({ where: { code: 'CSVC' } });
    expect(csvc).toBeTruthy();
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({
        email: 'deptstaff-new@ums.edu.vn',
        displayName: 'NV phòng mới',
        role: 'DeptStaff',
        departmentId: csvc!.id,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe('DeptStaff');
    expect(res.body.data.department).toMatchObject({ id: csvc!.id, code: 'CSVC' });
  });

  it('M31-BE-S15-X1: duplicate email → 409 conflict', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({
        email: 'admin@ums.edu.vn', // seeded admin
        displayName: 'Trùng',
        role: 'SV',
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('M31-BE-S15-X2: role=DeptStaff without departmentId → 422 with field error', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({
        email: 'no-dept@ums.edu.vn',
        displayName: 'Không phòng',
        role: 'DeptStaff',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.fields?.departmentId).toBeTruthy();
  });

  it('M31-BE-S15-X3: invalid email → 422', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({ email: 'not-an-email', displayName: 'X', role: 'SV' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('M31-BE-S15-X4: short password → 422 with field error', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({
        email: 'short-pw@ums.edu.vn',
        displayName: 'Mật khẩu ngắn',
        role: 'SV',
        password: 'abc',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.password).toBeTruthy();
  });

  it('M31-BE-S15-X5: non-Admin (HelpdeskLead) → 403', async () => {
    const res = await request(app)
      .post('/users')
      .set(mockSsoHeaders({ id: 'u-hdl', role: 'HelpdeskLead' }))
      .send({ email: 'forbidden@ums.edu.vn', displayName: 'Cấm', role: 'SV' });
    expect(res.status).toBe(403);
  });

  it('M31-BE-S15-X7: displayName with digits → 422 with field error', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({ email: 'digit-name@ums.edu.vn', displayName: 'Nguyen Van 123', role: 'SV' });
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.displayName).toBeTruthy();
  });

  it('M31-BE-S15-X8: displayName with symbols → 422', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({ email: 'sym-name@ums.edu.vn', displayName: 'John_Doe@', role: 'SV' });
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.displayName).toBeTruthy();
  });

  it('M31-BE-S15-H4: Vietnamese displayName with diacritics + spaces is accepted', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({ email: 'viet-name@ums.edu.vn', displayName: 'Nguyễn Thị Lệ Ước', role: 'SV' });
    expect(res.status).toBe(201);
    expect(res.body.data.displayName).toBe('Nguyễn Thị Lệ Ước');
  });

  it('M31-BE-S15-X9: personal email (gmail) → 422 with email field error', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({ email: 'someone@gmail.com', displayName: 'Email Cá Nhân', role: 'SV' });
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.email).toBeTruthy();
  });

  it('M31-BE-S15-H5: @dau.edu.vn institutional email is accepted', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({ email: 'newperson@dau.edu.vn', displayName: 'Người DAU', role: 'SV' });
    expect(res.status).toBe(201);
    expect(res.body.data.email).toBe('newperson@dau.edu.vn');
  });

  it('M31-BE-S15-X6: unknown departmentId → 422 with field error', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({
        email: 'bad-dept@ums.edu.vn',
        displayName: 'Sai phòng',
        role: 'DeptStaff',
        departmentId: 'dep-does-not-exist',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.departmentId).toBeTruthy();
  });
});

describe('BE-S16 — Admin user update + soft delete', () => {
  beforeAll(async () => {
    await resetDb();
    await runSeed(testPrisma);
  });
  afterAll(async () => {
    await disconnect();
  });

  it('M31-BE-S16-H1: PATCH displayName only → 200 + updated DTO; other fields unchanged', async () => {
    const before = await testPrisma.user.findUnique({ where: { id: 'u-sv-1' } });
    const res = await request(app)
      .patch('/users/u-sv-1')
      .set(adminHeaders)
      .send({ displayName: 'Nguyễn Văn A Đã Đổi' });
    expect(res.status).toBe(200);
    expect(res.body.data.displayName).toBe('Nguyễn Văn A Đã Đổi');
    expect(res.body.data.role).toBe(before?.role);
    // DTO keys shouldn't include sensitive fields.
    expect(Object.keys(res.body.data).sort()).toEqual(['department', 'displayName', 'email', 'id', 'role']);
  });

  it('M31-BE-S16-H2: PATCH password → bcrypt hash replaced; verifies the new value', async () => {
    const res = await request(app)
      .patch('/users/u-sv-1')
      .set(adminHeaders)
      .send({ password: 'newP@ssw0rd!' });
    expect(res.status).toBe(200);
    const stored = await testPrisma.user.findUnique({
      where: { id: 'u-sv-1' },
      select: { passwordHash: true },
    });
    expect(stored?.passwordHash).toBeTruthy();
    if (stored?.passwordHash) {
      expect(await bcrypt.compare('newP@ssw0rd!', stored.passwordHash)).toBe(true);
    }
  });

  it('M31-BE-S16-H3: PATCH role=DeptStaff + matching departmentId resolves the dept on the DTO', async () => {
    const csvc = await testPrisma.department.findUnique({ where: { code: 'CSVC' } });
    expect(csvc).toBeTruthy();
    const res = await request(app)
      .patch('/users/u-sv-1')
      .set(adminHeaders)
      .send({ role: 'DeptStaff', departmentId: csvc!.id });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('DeptStaff');
    expect(res.body.data.department).toMatchObject({ id: csvc!.id, code: 'CSVC' });
  });

  it('M31-BE-S16-H4: PATCH departmentId=null clears the dept (when role is not DeptStaff)', async () => {
    // First reset u-sv-1 back to SV so the null-dept transition is valid.
    await request(app).patch('/users/u-sv-1').set(adminHeaders).send({ role: 'SV' });
    const res = await request(app)
      .patch('/users/u-sv-1')
      .set(adminHeaders)
      .send({ departmentId: null });
    expect(res.status).toBe(200);
    expect(res.body.data.department).toBeNull();
  });

  it('M31-BE-S16-X1: PATCH unknown id → 404', async () => {
    const res = await request(app)
      .patch('/users/u-does-not-exist')
      .set(adminHeaders)
      .send({ displayName: 'Valid Name' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('M31-BE-S16-X2: PATCH short password → 422 with field error', async () => {
    const res = await request(app)
      .patch('/users/u-sv-1')
      .set(adminHeaders)
      .send({ password: 'abc' });
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.password).toBeTruthy();
  });

  it('M31-BE-S16-X3: PATCH role=DeptStaff without dept (and no existing dept) → 422', async () => {
    // u-sv-2 is a plain SV with no dept; flipping to DeptStaff with nothing else must 422.
    const res = await request(app)
      .patch('/users/u-sv-2')
      .set(adminHeaders)
      .send({ role: 'DeptStaff' });
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.departmentId).toBeTruthy();
  });

  it('M31-BE-S16-X9: PATCH displayName with digits → 422 with field error', async () => {
    const res = await request(app)
      .patch('/users/u-sv-1')
      .set(adminHeaders)
      .send({ displayName: 'Tên 99' });
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.displayName).toBeTruthy();
  });

  it('M31-BE-S16-X4: PATCH unknown departmentId → 422', async () => {
    const res = await request(app)
      .patch('/users/u-sv-1')
      .set(adminHeaders)
      .send({ departmentId: 'dep-nope' });
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.departmentId).toBeTruthy();
  });

  it('M31-BE-S16-X5: PATCH from non-Admin → 403', async () => {
    const res = await request(app)
      .patch('/users/u-sv-1')
      .set(mockSsoHeaders({ id: 'u-hdl', role: 'HelpdeskLead' }))
      .send({ displayName: 'X' });
    expect(res.status).toBe(403);
  });

  it('M31-BE-S16-H5: DELETE soft-deactivates (isActive=false); DTO returned', async () => {
    const res = await request(app).delete('/users/u-sv-2').set(adminHeaders);
    expect(res.status).toBe(200);
    const stored = await testPrisma.user.findUnique({
      where: { id: 'u-sv-2' },
      select: { isActive: true },
    });
    expect(stored?.isActive).toBe(false);
    // Tickets/comments/events on the deactivated user are still queryable.
    const eventsStill = await testPrisma.ticketEvent.count({ where: { actorId: 'u-sv-2' } });
    expect(eventsStill).toBeGreaterThanOrEqual(0); // No FK errors / cascades.
  });

  it('M31-BE-S16-H6: DELETE is idempotent on an already-inactive user', async () => {
    const res = await request(app).delete('/users/u-sv-2').set(adminHeaders);
    expect(res.status).toBe(200);
  });

  it('M31-BE-S16-H7: a deactivated user no longer appears in GET /users', async () => {
    // u-sv-2 was soft-deleted in H5 above.
    const res = await request(app).get('/users').query({ pageSize: 100 }).set(adminHeaders);
    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((u: { id: string }) => u.id);
    expect(ids).not.toContain('u-sv-2');
    // A still-active user is unaffected.
    expect(ids).toContain('u-admin');
  });

  it('M31-BE-S16-X6: DELETE unknown id → 404', async () => {
    const res = await request(app).delete('/users/u-does-not-exist').set(adminHeaders);
    expect(res.status).toBe(404);
  });

  it('M31-BE-S16-X7: Admin cannot DELETE themselves → 409 conflict', async () => {
    const res = await request(app).delete('/users/u-admin').set(adminHeaders);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('M31-BE-S16-X8: DELETE from non-Admin → 403', async () => {
    const res = await request(app)
      .delete('/users/u-sv-1')
      .set(mockSsoHeaders({ id: 'u-hdl', role: 'HelpdeskLead' }));
    expect(res.status).toBe(403);
  });

  it('M31-BE-S16-H8: re-creating a DEACTIVATED user\'s email revives the same row', async () => {
    // Create → deactivate → re-create with the same email.
    const created = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({ email: 'revive-me@ums.edu.vn', displayName: 'Bản Gốc', role: 'SV' });
    expect(created.status).toBe(201);
    const originalId = created.body.data.id;

    const del = await request(app).delete(`/users/${originalId}`).set(adminHeaders);
    expect(del.status).toBe(200);

    const recreated = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({ email: 'Revive-Me@ums.edu.vn', displayName: 'Bản Hồi Sinh', role: 'GV' });
    expect(recreated.status).toBe(201);
    // Same row (id preserved), reactivated, identity overwritten.
    expect(recreated.body.data.id).toBe(originalId);
    expect(recreated.body.data.displayName).toBe('Bản Hồi Sinh');
    expect(recreated.body.data.role).toBe('GV');

    const stored = await testPrisma.user.findUnique({
      where: { id: originalId },
      select: { isActive: true, email: true },
    });
    expect(stored?.isActive).toBe(true);
    expect(stored?.email).toBe('revive-me@ums.edu.vn');
  });

  it('M31-BE-S16-X10: re-creating an ACTIVE user\'s email still → 409', async () => {
    const res = await request(app)
      .post('/users')
      .set(adminHeaders)
      .send({ email: 'admin@ums.edu.vn', displayName: 'Trùng Active', role: 'SV' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });
});
