import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';
import { mockSsoHeaders } from '../helpers/sso-headers';

describe('Auth + RBAC middleware (BE-S1)', () => {
  const app = createTestApp();

  it('M31-BE-S1-E2: attaches req.user when X-Mock-* headers are present', async () => {
    const res = await request(app)
      .get('/_debug/auth-required')
      .set(mockSsoHeaders({ id: 'u-sv-1', role: 'SV' }));
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: 'u-sv-1', role: 'SV', departmentId: null });
  });

  it('M31-BE-S1-X1: without SSO headers → 401 error.code=unauthenticated', async () => {
    const res = await request(app).get('/_debug/auth-required');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ data: null, error: { code: 'unauthenticated' } });
    expect(res.body.requestId).toBeTruthy();
  });

  it('M31-BE-S1-X2: SV on an Admin-only route → 403 error.code=forbidden', async () => {
    const res = await request(app)
      .get('/_debug/admin-only')
      .set(mockSsoHeaders({ id: 'u-sv-1', role: 'SV' }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ data: null, error: { code: 'forbidden' } });
  });

  it('Admin reaches /_debug/admin-only', async () => {
    const res = await request(app)
      .get('/_debug/admin-only')
      .set(mockSsoHeaders({ id: 'u-admin-1', role: 'Admin' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: { ok: true } });
  });
});
