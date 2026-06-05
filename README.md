# M31 Helpdesk / Ticket — Back-end

Node 20 · **TypeScript** · Express 4 · Prisma 5 (Postgres) · Zod · bullmq · pino · `jsonwebtoken` + `bcryptjs` · vitest + supertest.
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

`AUTH_MODE=mock` (dev/test fallback) accepts the legacy `X-Mock-User-Id` / `X-Mock-Role` headers; the deployed BE runs in `jwt` mode.

## Status

**All phases shipped.** Phase 1 (foundation) → Phase 11 (hardening) of the implementation plan are live on Vercel + NeonDB.

- **Phase 1 — Foundation** — request-id, pino logger, Zod env validation, helmet, CORS, cookie-parser, envelope-shaped responses, structured `AppError` ladder (`401 unauthenticated` / `403 forbidden` / `404 not_found` / `409 conflict` / `422 validation_error`), `requireAuth` + RBAC middleware.
- **Phase 2 — Prisma schema + seed** — `User` / `Department` / `Category` / `Ticket` / `TicketComment` / `Attachment` / `TicketEvent` / `Notification`. Seed: 5 depts, 6 flat categories, 13 demo personas (idempotent upserts).
- **Phase 2.5 — Demo auth (2026-06-05)** — `POST /auth/login { email, password }` bcrypt-verifies and sets an `HttpOnly Secure SameSite=None ums_session` cookie (HS256, 8 h, no refresh). `POST /auth/logout` clears it idempotently; `GET /auth/me` rehydrates the session. Login is rate-limited (5/15 min/IP); CORS tightened to a credentialed origin allow-list.
- **Phase 3 — Categories** — flat Admin-managed list (`GET/POST/PATCH/DELETE /categories`); delete-guard `409`s when tickets reference the category.
- **Phase 4 — Tickets (read paths)** — `POST /tickets` with multipart upload, `GET /tickets` (caller-scoped + filters + pagination), `GET /tickets/:id`, `GET /tickets/:id/history`, `GET /attachments/:id`.
- **Phase 5 — State machine** — one Prisma transaction per transition: status read → guard → status write + `TicketEvent` insert + (optional) `Notification` insert. Stale-status writes → `409`. Routes: `/tickets/:id/{assign,forward,redirect,progress,close}` + `PATCH /:id/severity`.
- **Phase 6 — Comments + attachments** — `POST /tickets/:id/comments` with optional multipart attachments; participant + Helpdesk + Admin only.
- **Phase 7 — Notifications** — `GET /notifications` + `POST /notifications/:id/read` (caller-scoped). Lifecycle inserts wired into the transitions.
- **Phase 8 — Daily reminder cron** — `jobs/daily-reminder.ts` handler shared by local bullmq + Vercel Cron (`vercel.json` `crons`), Mon-Fri 09:00 ICT, public-holiday skip, Redis SETNX dedupe.
- **Phase 9 — EventPublisher** — `lib/events/publisher.ts` (logger adapter in dev, QStash stub for prod); publish failures never roll back the ticket transaction.
- **Phase 10 — Analytics summary** — `GET /analytics/summary` (Helpdesk / Admin / BGH only) — counts by severity / status / department / category + `avgHandlingDays`.
- **Phase 11 — Swagger / OpenAPI (ISO §8.3)** — full spec at `/openapi.json` + Swagger UI at `/docs` loaded from jsDelivr CDN (Vercel function bundling can't ship swagger-ui static assets). 5-check ISO-§8.3 conformance test in `tests/integration/swagger.test.ts`.

Gates: `tsc --noEmit` ✅ · `npm run lint` ✅ · `npm test` → **17 files / 87 tests** ✅ · live smoke-test of `POST /auth/login` returns the expected `Set-Cookie: ums_session=…; HttpOnly; Secure; SameSite=None` ✅.
