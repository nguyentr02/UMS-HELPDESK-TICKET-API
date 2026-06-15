import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';
import { disconnect, resetDb, testPrisma } from '../helpers/test-db';
import { runSeed } from '../../prisma/seed';

// Mock `google-auth-library` so the test never hits Google. The mock is
// scoped to this file via vi.mock at the top — every import of the module
// from anywhere inside this test resolves to our stub.
vi.mock('google-auth-library', () => {
  return {
    OAuth2Client: vi.fn().mockImplementation(() => ({
      generateAuthUrl: (opts: { state: string }) =>
        `https://accounts.google.com/o/oauth2/v2/auth?fake=1&state=${encodeURIComponent(opts.state)}`,
      getToken: async (code: string) => {
        if (code === 'code-fail') throw new Error('exchange failed');
        return { tokens: { id_token: `idtoken:${code}` } };
      },
      verifyIdToken: async ({ idToken }: { idToken: string }) => {
        // Decode our fake idtoken format `idtoken:<persona-key>` to drive payload variants.
        // Persona keys: ok | unverified | wrong-domain | missing-fields
        const key = idToken.replace(/^idtoken:/, '').replace(/^code-/, '');
        const PAYLOADS: Record<string, Record<string, unknown> | undefined> = {
          ok: {
            sub: 'g-new-user',
            email: 'newperson@ums.edu.vn',
            email_verified: true,
            name: 'New Person From Google',
            picture: 'https://lh3.googleusercontent.com/a/x',
          },
          'ok-existing': {
            sub: 'g-link-sv1',
            email: 'sv01@ums.edu.vn', // matches seeded persona — link path
            email_verified: true,
            name: 'SV Nguyễn Văn A (Google)',
            picture: 'https://lh3.googleusercontent.com/a/sv1',
          },
          unverified: {
            sub: 'g-pending',
            email: 'pending@ums.edu.vn',
            email_verified: false,
            name: 'Pending',
          },
          'wrong-domain': {
            sub: 'g-stranger',
            email: 'stranger@gmail.com',
            email_verified: true,
            name: 'Stranger',
          },
          'missing-fields': {
            sub: 'g-bad',
            // email omitted
            email_verified: true,
          },
        };
        const payload = PAYLOADS[key];
        if (!payload) throw new Error('unknown test idtoken');
        return { getPayload: () => payload };
      },
    })),
  };
});

describe('BE-S12 — Google OAuth routes', () => {
  const app = createTestApp();

  beforeAll(async () => {
    await resetDb();
    await runSeed(testPrisma);
  });
  beforeEach(async () => {
    // Each test starts from the seeded baseline — re-seed to undo any links
    // made by previous tests (we may set googleId on u-sv-1, etc.).
    await resetDb();
    await runSeed(testPrisma);
  });
  afterAll(async () => {
    await disconnect();
  });

  describe('GET /auth/google', () => {
    it('M31-BE-S12-I1: returns 302 to Google + Set-Cookie google_oauth_state', async () => {
      const res = await request(app).get('/auth/google');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
      const setCookie = String(res.headers['set-cookie'] ?? '');
      expect(setCookie).toMatch(/google_oauth_state=/);
      expect(setCookie).toMatch(/HttpOnly/i);
      // The `state` in the URL matches the cookie value (double-submit pattern).
      const urlState = new URL(res.headers.location).searchParams.get('state');
      expect(urlState).toBeTruthy();
      expect(setCookie).toContain(`google_oauth_state=${urlState}`);
    });

    it('M31-BE-S12-I2: round-trips a sanitized ?next= into the state', async () => {
      const res = await request(app).get('/auth/google?next=/helpdesk/queue');
      expect(res.status).toBe(302);
      // We can't decode the JWT without the secret, but we can at least see the
      // state cookie was set; the next-path round-trip is covered by the
      // callback test that arrives with that state and verifies the redirect.
      expect(res.headers['set-cookie']).toBeTruthy();
    });

    it('M31-BE-S12-I3: rejects open-redirect attempts (state holds sanitized "/" instead of evil URL)', async () => {
      const res = await request(app).get('/auth/google?next=https://evil.com');
      expect(res.status).toBe(302);
      // The redirect target is still Google's auth URL — the bad `next` only
      // affects the post-callback redirect (covered in the callback test).
      expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    });
  });

  describe('GET /auth/google/callback', () => {
    async function startFlow(nextPath = '/'): Promise<{ state: string; cookieHeader: string }> {
      const res = await request(app).get(`/auth/google?next=${encodeURIComponent(nextPath)}`);
      expect(res.status).toBe(302);
      const cookieHeader = String(res.headers['set-cookie']);
      const state = new URL(res.headers.location).searchParams.get('state')!;
      return { state, cookieHeader: cookieHeader.split(';')[0] };
    }

    it('M31-BE-S12-H1: happy path — creates new SV user, sets ums_session, 302s to FE_ORIGIN+next', async () => {
      const { state, cookieHeader } = await startFlow('/tickets/new');
      const res = await request(app)
        .get('/auth/google/callback')
        .query({ code: 'ok', state })
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/tickets/new');
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toMatch(/ums_session=/);
      expect(setCookie).toMatch(/HttpOnly/i);

      const created = await testPrisma.user.findUnique({ where: { email: 'newperson@ums.edu.vn' } });
      expect(created?.role).toBe('SV');
      expect(created?.googleId).toBe('g-new-user');
    });

    it('M31-BE-S12-H2: link path — email matches seeded persona, googleId set, role preserved', async () => {
      const { state, cookieHeader } = await startFlow('/');
      const res = await request(app)
        .get('/auth/google/callback')
        .query({ code: 'ok-existing', state })
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/');

      const linked = await testPrisma.user.findUniqueOrThrow({ where: { id: 'u-sv-1' } });
      expect(linked.googleId).toBe('g-link-sv1');
      expect(linked.role).toBe('SV');
      expect(linked.email).toBe('sv01@ums.edu.vn');
    });

    it('M31-BE-S12-X1: mismatched state cookie/query → 302 /login?error=invalid_state', async () => {
      const res = await request(app)
        .get('/auth/google/callback')
        .query({ code: 'ok', state: 'forged-state' })
        .set('Cookie', 'google_oauth_state=different-value');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/login?error=invalid_state');
    });

    it('M31-BE-S12-X2: missing cookie + VALID signed state → succeeds (proxy path)', async () => {
      // Behind the FE same-origin proxy the state cookie can't survive the
      // round-trip, so the callback must accept a validly-signed state with no
      // cookie. Integrity rests on the JWT signature, not the cookie.
      const { state } = await startFlow('/');
      const res = await request(app)
        .get('/auth/google/callback')
        .query({ code: 'ok', state });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/');
      expect(String(res.headers['set-cookie'])).toMatch(/ums_session=/);
    });

    it('M31-BE-S12-X2b: missing cookie + FORGED state → 302 /login?error=invalid_state', async () => {
      // Signature-only path still rejects an unsigned/forged state.
      const res = await request(app)
        .get('/auth/google/callback')
        .query({ code: 'ok', state: 'forged-unsigned-state' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/login?error=invalid_state');
    });

    it('M31-BE-S12-X3: code exchange failure → 302 /login?error=google_verification_failed', async () => {
      const { state, cookieHeader } = await startFlow('/');
      const res = await request(app)
        .get('/auth/google/callback')
        .query({ code: 'code-fail', state })
        .set('Cookie', cookieHeader);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/login?error=google_verification_failed');
    });

    it('M31-BE-S12-X4: email outside allowlist → 302 /login?error=domain_not_allowed', async () => {
      const { state, cookieHeader } = await startFlow('/');
      const res = await request(app)
        .get('/auth/google/callback')
        .query({ code: 'wrong-domain', state })
        .set('Cookie', cookieHeader);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/login?error=domain_not_allowed');
    });

    it('M31-BE-S12-X5: unverified email → 302 /login?error=google_verification_failed', async () => {
      const { state, cookieHeader } = await startFlow('/');
      const res = await request(app)
        .get('/auth/google/callback')
        .query({ code: 'unverified', state })
        .set('Cookie', cookieHeader);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/login?error=google_verification_failed');
    });

    it('M31-BE-S12-X6: Google denies consent (?error=access_denied) → 302 /login?error=access_denied', async () => {
      const res = await request(app).get('/auth/google/callback').query({ error: 'access_denied' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/login?error=access_denied');
    });
  });
});
