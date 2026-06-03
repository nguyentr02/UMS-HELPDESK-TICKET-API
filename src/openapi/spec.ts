import type { OpenAPIV3 } from 'openapi-types';
import { responses, schemas, securitySchemes } from './components.js';
import { paths } from './paths.js';

export const openApiSpec: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'M31 — Helpdesk / Ticket API',
    version: '0.1.0',
    description:
      'Back-end for the M31 Helpdesk/Ticket module of UMS (CAIRA-DAU). Practice-mode build; mock SSO via `X-Mock-*` headers in dev (real SSO in prod). Every endpoint returns the envelope `{ data | error, requestId }`. See ISO §8.3 for the API-documentation standard this spec is written against.',
  },
  servers: [{ url: 'http://localhost:4000', description: 'Local dev (tsx --watch)' }],
  tags: [
    { name: 'Healthz', description: 'Liveness & readiness probes.' },
    { name: 'Categories', description: 'Ticket categories (Admin-managed; any role can read).' },
    { name: 'Tickets', description: 'Tickets — create / list / detail / history.' },
    { name: 'Attachments', description: 'Attachment downloads (server-scoped).' },
    { name: 'Notifications', description: 'In-app notifications inbox (caller-scoped).' },
    { name: 'Jobs', description: 'Cron-invoked job endpoints (bearer-authenticated, not user-facing).' },
    { name: 'Analytics', description: 'Aggregated ticket counts (Helpdesk / Admin only).' },
  ],
  components: { schemas, responses, securitySchemes },
  security: [{ MockUserId: [], MockRole: [] }],
  paths,
};
