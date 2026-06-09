import type { OpenAPIV3 } from 'openapi-types';
import { responses, schemas, securitySchemes } from './components.js';
import { paths } from './paths.js';

export const openApiSpec: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'M31 — Helpdesk / Ticket API',
    version: '0.2.0',
    description:
      'Back-end for the M31 Helpdesk/Ticket module of UMS (CAIRA-DAU).\n\n' +
      '**Authentication** — `POST /auth/login` with `{ email, password }` against a seeded demo persona returns a signed JWT in an `HttpOnly Secure SameSite=None` cookie (`ums_session`, 8 h, no refresh). Subsequent requests carry the cookie automatically; `GET /auth/me` rehydrates the session; `POST /auth/logout` clears it. The legacy `X-Mock-*` header path remains in non-prod environments only.\n\n' +
      'Every endpoint returns the envelope `{ data | error, requestId }`. See ISO §8.3 for the API-documentation standard this spec is written against.',
  },
  servers: [
    { url: 'https://ums-helpdesk-api.vercel.app', description: 'Production (Vercel + NeonDB)' },
    { url: 'http://localhost:4000', description: 'Local dev (tsx --watch)' },
  ],
  tags: [
    { name: 'Auth', description: 'Demo login / logout / session rehydrate.' },
    { name: 'Healthz', description: 'Liveness & readiness probes.' },
    { name: 'Categories', description: 'Ticket categories (Admin-managed; any role can read).' },
    { name: 'Tickets', description: 'Tickets — create / list / detail / history.' },
    { name: 'Attachments', description: 'Attachment downloads (server-scoped).' },
    { name: 'Notifications', description: 'In-app notifications inbox (caller-scoped).' },
    { name: 'Jobs', description: 'Cron-invoked job endpoints (bearer-authenticated, not user-facing).' },
    { name: 'Analytics', description: 'Aggregated ticket counts (Helpdesk / Admin only).' },
    { name: 'Users', description: 'Admin-only read-only user directory.' },
  ],
  components: { schemas, responses, securitySchemes },
  security: [{ SessionCookie: [] }],
  paths,
};
