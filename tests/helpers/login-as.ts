import request from 'supertest';
import type { Express } from 'express';
import type { PersonaSeed } from '../../prisma/seed';

/**
 * Logs a seeded persona in via `POST /auth/login` and returns the raw `Set-Cookie`
 * header so downstream supertest calls can replay it via `.set('Cookie', ...)`.
 * Used by integration tests that exercise the real JWT cookie path; existing
 * `X-Mock-*` header tests are unaffected.
 */
export async function loginAs(
  app: Express,
  persona: Pick<PersonaSeed, 'email' | 'password'>,
): Promise<string[]> {
  const res = await request(app)
    .post('/auth/login')
    .send({ email: persona.email, password: persona.password });
  if (res.status !== 200) {
    throw new Error(`loginAs(${persona.email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error(`loginAs(${persona.email}): no Set-Cookie returned`);
  return Array.isArray(setCookie) ? setCookie : [setCookie];
}
