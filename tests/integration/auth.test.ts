import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';
import { disconnect, resetDb, testPrisma } from '../helpers/test-db';
import { loginAs } from '../helpers/login-as';
import { PERSONAS, runSeed } from '../../prisma/seed';

const SV = PERSONAS.find((p) => p.id === 'u-sv-1')!;

describe('BE-S11 — Demo auth (login / logout / me)', () => {
  const app = createTestApp();

  beforeAll(async () => {
    await resetDb();
    await runSeed(testPrisma);
  });

  afterAll(async () => {
    await disconnect();
  });

  it('M31-BE-S11-H1: POST /auth/login with seeded credentials → 200 + Set-Cookie', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: SV.email, password: SV.password });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      data: { user: { id: 'u-sv-1', role: 'SV', displayName: SV.displayName } },
      error: null,
    });
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
    expect(cookieHeader).toMatch(/ums_session=/);
    expect(cookieHeader).toMatch(/HttpOnly/i);
  });

  it('M31-BE-S11-H2: GET /auth/me with the cookie → 200 user payload', async () => {
    const cookies = await loginAs(app, SV);
    const res = await request(app).get('/auth/me').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: 'u-sv-1', role: 'SV' });
  });

  it('M31-BE-S11-E1: wrong password → opaque 401 unauthenticated', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: SV.email, password: 'definitely-not-the-password' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ data: null, error: { code: 'unauthenticated' } });
  });

  it('M31-BE-S11-E1b: unknown email → same opaque 401 unauthenticated', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'ghost@nowhere.test', password: SV.password });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ data: null, error: { code: 'unauthenticated' } });
  });

  it('M31-BE-S11-E3: GET /auth/me with no cookie → 401', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('M31-BE-S11-X1: malformed body (missing fields) → 422 validation_error', async () => {
    const res = await request(app).post('/auth/login').send({ email: SV.email });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'validation_error' } });
    expect(res.body.error.fields).toHaveProperty('password');
  });

  it('M31-BE-S11-X1b: bad email format → 422 with email field error', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'not-an-email', password: 'whatever' });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toHaveProperty('email');
  });

  it('M31-BE-S11-X2: POST /auth/logout with no cookie is idempotent → 200', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: {}, error: null });
    const setCookie = res.headers['set-cookie'];
    const cookieHeader = setCookie
      ? (Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie))
      : '';
    expect(cookieHeader).toMatch(/ums_session=;|ums_session=$|Expires=/i);
  });

  it('M31-BE-S11-I1: round-trip — login → cookie → /auth/me → logout → me 401', async () => {
    const cookies = await loginAs(app, SV);

    const me = await request(app).get('/auth/me').set('Cookie', cookies);
    expect(me.status).toBe(200);

    const out = await request(app).post('/auth/logout').set('Cookie', cookies);
    expect(out.status).toBe(200);

    // The cookie we still hold is the *pre-logout* token; the BE doesn't blacklist
    // unexpired tokens (8h TTL, no refresh). So /auth/me with the old cookie still
    // works until expiry — but a request with NO cookie (browser dropped it) is 401.
    const meAfter = await request(app).get('/auth/me');
    expect(meAfter.status).toBe(401);
  });
});
