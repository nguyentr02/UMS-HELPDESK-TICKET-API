import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';

describe('Error middleware (BE-S1-I1)', () => {
  const app = createTestApp();

  it('M31-BE-S1-I1: thrown error is enveloped; requestId matches X-Request-Id header', async () => {
    const res = await request(app).get('/_debug/throw');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ data: null, error: { code: 'internal_error' } });
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('an unknown endpoint returns the envelope 404', async () => {
    const res = await request(app).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ data: null, error: { code: 'not_found' } });
  });
});
