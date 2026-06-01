import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';
import { env } from '../../src/config/env';
import { runSeed } from '../../prisma/seed';
import { disconnect, resetDb, testPrisma as prisma } from '../helpers/test-db';

const app = createTestApp();

describe('BE-S8 — Jobs route (bearer guard)', () => {
  beforeEach(async () => {
    await resetDb();
    await runSeed(prisma);
  });
  afterAll(async () => {
    await disconnect();
  });

  it('POST /jobs/daily-reminder without an Authorization header → 403', async () => {
    const res = await request(app).post('/jobs/daily-reminder').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('POST /jobs/daily-reminder with a wrong bearer secret → 403', async () => {
    const res = await request(app)
      .post('/jobs/daily-reminder')
      .set('Authorization', 'Bearer not-the-real-secret')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('POST /jobs/daily-reminder with the correct bearer secret → 200 envelope with run summary', async () => {
    expect(env.JOB_SECRET).toBeTruthy();
    const res = await request(app)
      .post('/jobs/daily-reminder')
      .set('Authorization', `Bearer ${env.JOB_SECRET}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      agentsScanned: expect.any(Number),
      notificationsInserted: expect.any(Number),
    });
    expect(res.body.requestId).toBeTruthy();
  });
});
