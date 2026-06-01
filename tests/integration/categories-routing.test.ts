import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';
import { mockSsoHeaders } from '../helpers/sso-headers';
import { runSeed } from '../../prisma/seed';
import { disconnect, resetDb, testPrisma as prisma } from '../helpers/test-db';

const app = createTestApp();
const adminHeaders = mockSsoHeaders({ id: 'u-admin', role: 'Admin' });
const svHeaders = mockSsoHeaders({ id: 'u-sv', role: 'SV' });

describe('BE-S3 — Categories + Routing Rules CRUD', () => {
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
    expect(post.body.data).toMatchObject({ name: 'IT mới', parentId: null, isActive: true });
    expect(post.body.requestId).toBeTruthy();

    const list = await request(app).get('/categories').set(adminHeaders);
    expect(list.status).toBe(200);
    const names = (list.body.data as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain('IT mới');
  });

  it('M31-BE-S3-E1: Admin can create a child category (parentId set)', async () => {
    const parent = await prisma.category.findFirstOrThrow({
      where: { name: 'IT / Hệ thống số', parentId: null },
    });
    const res = await request(app)
      .post('/categories')
      .set(adminHeaders)
      .send({ name: 'Email server', parentId: parent.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Email server', parentId: parent.id });
  });

  it('M31-BE-S3-E2: POST /routing-rules with isDefault=true unsets the prior default for the same category (same tx)', async () => {
    const category = await prisma.category.findFirstOrThrow({
      where: { name: 'Cơ sở vật chất (CSVC)', parentId: null },
    });
    const newDept = await prisma.department.findFirstOrThrow({ where: { code: 'HCNS' } });

    // Sanity: the seed already gave CSVC a single default rule.
    const before = await prisma.routingRule.findMany({
      where: { categoryId: category.id, isDefault: true },
    });
    expect(before).toHaveLength(1);

    const res = await request(app).post('/routing-rules').set(adminHeaders).send({
      categoryId: category.id,
      departmentId: newDept.id,
      isDefault: true,
    });
    expect(res.status).toBe(201);

    const defaults = await prisma.routingRule.findMany({
      where: { categoryId: category.id, isDefault: true },
    });
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.departmentId).toBe(newDept.id);
  });

  it('M31-BE-S3-X1: non-admin (SV) POST /categories → 403', async () => {
    const res = await request(app).post('/categories').set(svHeaders).send({ name: 'Random' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('M31-BE-S3-X2: duplicate name within same parent → 422 fields.name', async () => {
    await request(app).post('/categories').set(adminHeaders).send({ name: 'Dup' });
    const res = await request(app).post('/categories').set(adminHeaders).send({ name: 'Dup' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'validation_error' });
    expect(res.body.error.fields?.name).toMatch(/đã tồn tại/);
  });

  it('M31-BE-S3-X3: DELETE a category that has children → 409 (delete guard)', async () => {
    const parent = await prisma.category.findFirstOrThrow({
      where: { name: 'IT / Hệ thống số', parentId: null },
    });
    await prisma.category.create({ data: { name: 'child-test', parentId: parent.id } });

    const res = await request(app).delete(`/categories/${parent.id}`).set(adminHeaders);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'conflict' });
  });

  it('M31-BE-S3-I1: Admin updates a routing rule → list reflects the new default', async () => {
    const category = await prisma.category.findFirstOrThrow({
      where: { name: 'Cơ sở vật chất (CSVC)', parentId: null },
    });
    const existingDefault = await prisma.routingRule.findFirstOrThrow({
      where: { categoryId: category.id, isDefault: true },
    });

    const patch = await request(app)
      .patch(`/routing-rules/${existingDefault.id}`)
      .set(adminHeaders)
      .send({ isDefault: false });
    expect(patch.status).toBe(200);

    const list = await request(app)
      .get('/routing-rules')
      .query({ categoryId: category.id })
      .set(adminHeaders);
    expect(list.status).toBe(200);
    const defaults = (list.body.data as Array<{ isDefault: boolean }>).filter((r) => r.isDefault);
    expect(defaults).toHaveLength(0);
  });
});
