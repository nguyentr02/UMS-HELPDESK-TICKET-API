import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';

describe('GET /healthz (BE-S1)', () => {
  const app = createTestApp();

  it('M31-BE-S1-H1: returns 200 with envelope { data: { status: "ok" } }', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: { status: 'ok' }, error: null });
    expect(res.body.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('M31-BE-S1-E1: is public — works without any SSO headers', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
  });
});
