# M31 Helpdesk / Ticket — Back-end

Node 22 · **TypeScript** · Express 4 · Prisma 5 (Postgres) · Zod · bullmq · pino · `jsonwebtoken` + `bcryptjs` · `google-auth-library` · `@vercel/blob` + `@vercel/functions` · `swagger-ui-express` · vitest + supertest.
Hosting: **Vercel** serverless (`api/index.ts`) + **NeonDB** Postgres in prod. Local dev via `tsx --watch` against docker-compose Postgres + Redis.

- **Live API**: <https://ums-helpdesk-api.vercel.app>
- **Swagger UI**: <https://ums-helpdesk-api.vercel.app/docs> · raw spec at `/openapi.json`

## Design docs

- [`docs/brief.md`](docs/brief.md) — Brief (problem & goals)
- [`docs/feature-plan.md`](docs/feature-plan.md) — Feature Plan (architecture · state machine · API contract · data model · auth)
- [`docs/test-design.md`](docs/test-design.md) — Test design (vitest unit / service / supertest integration)
- [`docs/impl-plans/feat-M31-helpdesk-be.md`](docs/impl-plans/feat-M31-helpdesk-be.md) — Implementation plan (phases + status)

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Express via `tsx watch src/index.ts` (binds `PORT`, default 4000) |
| `npm run worker` | bullmq worker via `tsx watch src/worker.ts` (local-only; on Vercel it's a cron-invoked endpoint) |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `npm test` / `coverage` | Vitest run / with coverage |
| `npm run prisma:migrate` | `prisma migrate dev` against the docker-compose Postgres |
| `npm run prisma:reset` | Reset + reseed local DB |

## Environment

Required when `AUTH_MODE=jwt` (the prod default):

- `DATABASE_URL` — Postgres connection string (Neon in prod, docker-compose in dev)
- `JWT_SECRET` — HS256 signing key (≥ 32 chars)
- `CORS_ORIGIN` — comma-separated FE origins allowed to send credentialed requests (e.g. `https://umshelpdesk.vercel.app,http://localhost:3000`)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` — Google OAuth Web client (the `/auth/google` routes verify against these; the callback URL must be allowlisted in Google Cloud Console)
- `FE_ORIGIN` — where the BE redirects the browser after a successful Google callback (e.g. `https://umshelpdesk.vercel.app`)

Optional / driver-selected:

- `STORAGE_DRIVER` — `local` (default) · `memory` · `blob` (Vercel Blob) · `s3`
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob token (read via `process.env`); required by the `/attachments/upload-url` broker and the orphan-blob sweep when `STORAGE_DRIVER=blob`
- `EVENT_PUBLISHER_DRIVER` — `logger` (default, dev) · `qstash` (Vercel prod); `QSTASH_TOKEN` required when `qstash`
- `JOB_SECRET` — bearer secret guarding the cron job endpoints (`/jobs/*`); on Vercel the platform-injected `CRON_SECRET`
- `REALTIME_EMIT_URL` / `REALTIME_EMIT_SECRET` / `REALTIME_JWT_SECRET` — Socket.IO push for the notification bell; when unset, emits are skipped and the FE falls back to its 30 s poll. `REALTIME_JWT_SECRET` falls back to `JWT_SECRET`
- `REDIS_URL` — Redis (daily-reminder dedupe; Upstash in prod, docker-compose in dev)
- `HELPDESK_ENABLED` — module kill-switch (default `true`)
- `LOG_LEVEL` — pino level (`trace`…`silent`, default `info`)
- `PORT` — local listen port (default 4000; on Vercel the platform invokes the handler)

`AUTH_MODE=mock` (dev/test fallback) accepts the legacy `X-Mock-User-Id` / `X-Mock-Role` headers; the deployed BE runs in `jwt` mode.

## Status

**All phases shipped.** Phase 1 (foundation) → Phase 11 (hardening) of the implementation plan, plus the later attachment-hardening, Google-OAuth, and user-management work, are live on Vercel + NeonDB.

- **Phase 1 — Foundation** — request-id, pino logger, Zod env validation, helmet, CORS, cookie-parser, envelope-shaped responses, structured `AppError` ladder (`401 unauthenticated` / `403 forbidden` / `404 not_found` / `409 conflict` / `422 validation_error`), `requireAuth` + RBAC middleware.
- **Phase 2 — Prisma schema + seed** — `User` / `Department` / `Category` / `Ticket` / `TicketComment` / `Attachment` / `TicketEvent` / `Notification`. Seed: 5 depts, 6 flat categories, 13 demo personas (idempotent upserts).
- **Phase 2.5 — Demo auth (2026-06-05)** — `POST /auth/login { email, password }` bcrypt-verifies and sets an `HttpOnly Secure SameSite=None ums_session` cookie (HS256, 8 h, no refresh). `POST /auth/logout` clears it idempotently; `GET /auth/me` rehydrates the session. Login is rate-limited (5/15 min/IP); CORS tightened to a credentialed origin allow-list.
- **Phase 3 — Categories** — flat Admin-managed list (`GET/POST/PATCH/DELETE /categories`); delete-guard `409`s when tickets reference the category.
- **Phase 4 — Tickets (read paths)** — `POST /tickets` with attachments, `GET /tickets` (caller-scoped + filters + pagination), `GET /tickets/:id`, `GET /tickets/:id/history`, `GET /attachments/:id`. The primary upload path is the **Vercel Blob direct-upload broker** (`POST /attachments/upload-url`, auth-gated): the browser SDK mints a short-lived token and uploads straight to Blob, bypassing the function-body limit; `POST /tickets` then carries the resulting URL. `GET /attachments/:id` re-checks per-ticket authorization and serves images/PDFs `inline` for preview (everything else `Content-Disposition: attachment`).
- **Phase 5 — State machine** — one Prisma transaction per transition: status read → guard → status write + `TicketEvent` insert + (optional) `Notification` insert. Stale-status writes → `409`. Routes: `/tickets/:id/{assign,forward,redirect,progress,close}` + `PATCH /:id/severity`.
- **Phase 6 — Comments + attachments** — `POST /tickets/:id/comments` with optional multipart attachments; participant + Helpdesk + Admin only.
- **Phase 7 — Notifications** — `GET /notifications` + `POST /notifications/:id/read` (caller-scoped). Lifecycle inserts wired into the transitions.
- **Phase 8 — Daily reminder cron** — `jobs/daily-reminder.ts` handler shared by local bullmq + Vercel Cron (`vercel.json` `crons` → `POST /jobs/daily-reminder` at `0 2 * * 1-5`), Mon-Fri 09:00 ICT, public-holiday skip, Redis SETNX dedupe. A second cron (`POST /jobs/blob-sweep` at `0 3 * * *`) GCs orphaned Blob objects. Both are guarded by the `JOB_SECRET` bearer.
- **Phase 9 — EventPublisher** — `lib/events/publisher.ts` (logger adapter in dev, QStash stub for prod); publish failures never roll back the ticket transaction.
- **Phase 10 — Analytics summary** — `GET /analytics/summary` (Helpdesk / Admin / BGH only) — counts by severity / status / department / category + `avgHandlingDays`.
- **Phase 11 — Swagger / OpenAPI (ISO §8.3)** — full spec at `/openapi.json` + Swagger UI at `/docs` loaded from jsDelivr CDN (Vercel function bundling can't ship swagger-ui static assets). 5-check ISO-§8.3 conformance test in `tests/integration/swagger.test.ts`.
- **Attachment hardening** — Vercel Blob direct-upload broker (`POST /attachments/upload-url`); magic-byte content sniffing + MIME allowlist (`lib/upload-validation.ts`); a virus-scan hook (`setVirusScanner`, no-op by default); Blob-path validation (`validateBlobAttachment` — range-fetch header sniff + true-size check) for files the BE never buffered; Blob-URL `storageKey` reads independent of `STORAGE_DRIVER` (`AttachmentService`); an orphan-Blob GC sweep (`jobs/blob-sweep.ts` + its `0 3 * * *` cron); inline image/PDF preview serving on `GET /attachments/:id`.
- **Phase 12 — Google OAuth** — `GET /auth/google` + `GET /auth/google/callback` (Authorization Code Flow via `google-auth-library`: signed `state`, ID-token verification through Google's JWKS, domain-allowlisted upsert, then session cookie). `requireAuth` re-validates the session against the DB on every request — a deactivated user is rejected immediately and role/dept are refreshed from the DB source of truth.
- **User management** — full Admin user CRUD on top of Category management: `POST /users`, `PATCH /users/:id`, `DELETE /users/:id` (soft-delete via `isActive`, email immutable, no self-delete).
- **Close-request / redirect workflows** — `CloseRequested` / `RedirectRequested` ticket states: a DeptStaff requests close/redirect, an Agent/Lead approves or refuses, with matching events + notifications.

Gates: `tsc --noEmit` ✅ · `npm run lint` ✅ · `npm test` → **213 tests / 26 files** ✅ · live smoke-test of `POST /auth/login` returns the expected `Set-Cookie: ums_session=…; HttpOnly; Secure; SameSite=None` ✅.
