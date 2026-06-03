import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';
import { mockSsoHeaders } from '../helpers/sso-headers';
import { runSeed } from '../../prisma/seed';
import { disconnect, resetDb, testPrisma as prisma } from '../helpers/test-db';

const app = createTestApp();
const adminHeaders = mockSsoHeaders({ id: 'u-admin', role: 'Admin' });
const svHeaders = mockSsoHeaders({ id: 'u-sv', role: 'SV' });

describe('BE-S3 — Categories CRUD (flat, no routing rules)', () => {
  beforeEach(async () => {
    await resetDb();
    await runSeed(prisma);
  });

  afterAll(async () => {
    await disconnect();
  });

  it('M31-BE-S3-H1: Admin POST /categories → 201; GET /categories includes it', async () => {
    const post = await request(app)
      .post('/categories')
      .set(adminHeaders)
      .send({ name: 'IT mới' });
    expect(post.status).toBe(201);
    expect(post.body.data).toMatchObject({ name: 'IT mới', isActive: true });
    expect(post.body.data).not.toHaveProperty('parentId');
    expect(post.body.requestId).toBeTruthy();

    const list = await request(app).get('/categories').set(adminHeaders);
    expect(list.status).toBe(200);
    const names = (list.body.data as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain('IT mới');
  });

  it('M31-BE-S3-X1: non-admin (SV) POST /categories → 403', async () => {
    const res = await request(app).post('/categories').set(svHeaders).send({ name: 'Random' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('M31-BE-S3-X2: duplicate name (global, since categories are flat) → 422 fields.name', async () => {
    await request(app).post('/categories').set(adminHeaders).send({ name: 'Dup' });
    const res = await request(app).post('/categories').set(adminHeaders).send({ name: 'Dup' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'validation_error' });
    expect(res.body.error.fields?.name).toMatch(/đã tồn tại/);
  });

  it('M31-BE-S3-I1: Admin can update + delete a category', async () => {
    const created = await request(app)
      .post('/categories')
      .set(adminHeaders)
      .send({ name: 'Tạm' });
    const id = created.body.data.id as string;

    const patch = await request(app)
      .patch(`/categories/${id}`)
      .set(adminHeaders)
      .send({ name: 'Tạm sửa' });
    expect(patch.status).toBe(200);
    expect(patch.body.data).toMatchObject({ id, name: 'Tạm sửa' });

    const del = await request(app).delete(`/categories/${id}`).set(adminHeaders);
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ id });
  });
});
