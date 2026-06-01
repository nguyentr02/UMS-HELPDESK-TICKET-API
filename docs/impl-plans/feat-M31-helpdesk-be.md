# Implementation Plan (BE) — M31 Helpdesk / Ticket

| Field | Value |
|---|---|
| Module | **M31 — Helpdesk / Ticket** — Back-end |
| Sources | `docs/brief.md`, `docs/feature-plan.md` (§A decisions, §C state machine, §E data model, §F API contract, §M Stories), `docs/test-design.md` |
| Step | Process Step 5 — Implementation plan (`/sc:workflow --detail --persona-architect`) |
| Output of this step | **This document only** — no code yet (Step 6 `/sc:implement`) |
| Stack | Node 20 · **TypeScript** · Express 4 · Prisma 5 (Postgres) · Zod · multer · bullmq · pino · vitest + supertest |
| Hosting | **Vercel serverless** (prod) + local dev via `tsx --watch` |
| Reference repo | `feat-admission-plan/` (JS) — patterns mirrored, language deliberately switched to TS |

---

## A. Plan decisions (re-confirming FP §A; flag any to change before Step 6)

1. Single Express app + a sibling worker entry; the same `jobs/daily-reminder.ts` handler is invoked from both runtimes.
2. Folder/test layout mirrors `feat-admission-plan` with TS extensions.
3. **TypeScript** (`tsx --watch` dev, `tsc → dist/` prod); `tsconfig.json` `module: esnext`, `moduleResolution: bundler`, `strict: true`.
4. Mock SSO via dev headers (`X-Mock-User-Id`, `X-Mock-Role`, `X-Mock-Dept-Id`) toggled by `AUTH_MODE=mock`.
5. EventPublisher with a logger adapter in dev; prod adapter (QStash or direct HTTPS) decided at Phase 9.
6. Attachment `StorageAdapter`: local-disk in dev; production adapter is an **open §K item** (Vercel Blob / S3 / R2).
7. **Hosting: Vercel** — `app.ts` exported as serverless handler; `vercel.json` `crons:` drives the 09:00 reminder; managed Postgres (Vercel/Neon) + managed Redis (Upstash).

## B. Target folder structure

```
feat-helpdesk-api/
  docs/                          # brief, feature-plan, test-design, this plan
  prisma/
    schema.prisma
    migrations/0001_create_m31_helpdesk/{migration.sql,migration.down.sql}
    seed.ts                      # departments + categories + default routing rules
  src/
    index.ts                     # API entry (binds Express; `app.listen` only when !VERCEL)
    worker.ts                    # local bullmq worker entry (tsx --watch worker.ts)
    app.ts                       # Express app factory; also default-exported as the Vercel handler
    config/env.ts                # Zod-validated process.env
    middleware/
      requestId.ts  auth.ts  rbac.ts  zodValidate.ts  multer.ts  error.ts
    routes/
      healthz.ts  categories.ts  routingRules.ts  tickets.ts  notifications.ts
      analytics.ts  jobs.ts      # POST /jobs/daily-reminder (Vercel-Cron-invoked)
    services/
      TicketService.ts  CategoryService.ts  RoutingService.ts  AssignmentService.ts
      NotificationService.ts  AttachmentService.ts  AnalyticsService.ts
    lib/
      logger.ts  prisma.ts  ids.ts  envelope.ts  errors.ts  scoping.ts
      storage/{index.ts,local.ts,blob.ts}     # StorageAdapter interface + adapters
      events/{publisher.ts,logger-adapter.ts,qstash-adapter.ts}
      calendar.ts                # public-holiday list + isHoliday()
      transitions.ts             # the §C transition table as a typed map
    types/domain.ts              # Zod schemas + z.infer types mirroring FP §4
    jobs/daily-reminder.ts       # cron handler (shared by local worker + Vercel cron)
  tests/
    helpers/{test-db.ts,seed-tickets.ts,sso-headers.ts,app-factory.ts,clock.ts}
    unit/                        # mappers, scoping, zod schemas, envelope, transitions
    service/                     # *Service against the test DB
    integration/                 # supertest against app.ts + test DB + fake publisher
  vercel.json                    # routes + crons (09:00 Mon–Fri Asia/Ho_Chi_Minh)
  docker-compose.yml             # postgres:15 + redis:7 (dev/CI)
  package.json  tsconfig.json  vitest.config.ts
  .env / .env.example  .eslintrc.cjs  .prettierrc
  .github/workflows/ci.yml
```

## C. Phased build order (each phase: files → tests → checkpoint)

### Phase 0 — Scaffold & tooling  *(blocks all)*
- [ ] `package.json` (Node 20 engines, ESM `"type":"module"`, `tsx`/`tsc`/`vitest` scripts).
- [ ] `tsconfig.json` (`strict`, `module: esnext`, `moduleResolution: bundler`, `outDir: dist`, `noEmit: false` for build).
- [ ] ESLint + Prettier (`@typescript-eslint/*`, `eslint-config-prettier`).
- [ ] `vitest.config.ts` (Node env, separate projects for `unit`/`service`/`integration`).
- [ ] `docker-compose.yml` mirrors `feat-admission-plan` (postgres:15-alpine + redis:7-alpine + healthchecks).
- [ ] `.env.example` (`DATABASE_URL`, `REDIS_URL`, `AUTH_MODE`, `JOB_SECRET`, `STORAGE_DRIVER`, `EVENT_PUBLISHER_DRIVER`, `HELPDESK_ENABLED`).
- [ ] `.github/workflows/ci.yml`: spin up the compose, `prisma migrate deploy`, `npm run lint && typecheck && test -- --coverage && build`.
- **Checkpoint:** `npm run typecheck` clean; an empty `tests/unit/sanity.test.ts` passes via `vitest run`.

### Phase 1 — Foundation: env, logger, prisma, envelope, requestId, auth, rbac, error, healthz  *(BE-S1)*
- [ ] `lib/logger.ts` (pino + pino-http; redacts `authorization`, `x-mock-*`, `password`).
- [ ] `lib/prisma.ts` (singleton; `log: ['warn','error']`).
- [ ] `lib/envelope.ts` + `lib/errors.ts` (`AppError`, `ValidationError`, `ConflictError`, etc., with codes + status).
- [ ] `config/env.ts` (Zod schema; reject on boot if invalid).
- [ ] `middleware/requestId.ts` (header or generate; attaches `req.id`).
- [ ] `middleware/auth.ts` (mock mode: read `X-Mock-*`; passport mode: hookable stub — wired at deploy).
- [ ] `middleware/rbac.ts` (capability table; throws `ForbiddenError`).
- [ ] `middleware/zodValidate.ts` (per-route Zod parse → `ValidationError`).
- [ ] `middleware/error.ts` (final handler; shapes envelope; logs with `requestId`).
- [ ] `routes/healthz.ts` (public, returns `{ status:'ok' }`).
- [ ] `app.ts` (build the Express instance; export default for Vercel handler).
- [ ] `index.ts` (`if (!process.env.VERCEL) app.listen(PORT)` — local only).
- **Tests:** `M31-BE-S1-H1`, `-E1..2`, `-X1..2`, `-I1` — all via supertest against `app.ts`.
- **Checkpoint:** `vitest run` green; `tsc --noEmit` clean; `npm run build` produces `dist/`.

### Phase 2 — Prisma schema + migration + seed  *(BE-S2)*
- [ ] `prisma/schema.prisma` — models per FP §E (PascalCase enums; `@@map` snake_case; cuid IDs; indexes).
- [ ] `0001_create_m31_helpdesk/migration.sql` (generated then committed) + `migration.down.sql` (hand-written DROP set).
- [ ] `prisma/seed.ts` — upsert 5 departments, 6 categories, default routing rules.
- [ ] `tests/helpers/test-db.ts` — `truncate ... cascade` for M31 tables; `applyMigrations()`; `seedFixtures()`.
- **Tests:** `M31-BE-S2-H1..I1` (migration + seed idempotency + down-script scope + post-seed `GET /categories`).
- **Checkpoint:** `prisma migrate dev` → `prisma migrate reset` → green test run.

### Phase 3 — Categories + routing-rules (Admin CRUD)  *(BE-S3)*
- [ ] `services/CategoryService.ts` (create/update/delete + delete-guard).
- [ ] `services/RoutingService.ts` (list/create/update/delete; transactional "unset other defaults for the same category" when `isDefault=true`).
- [ ] `routes/categories.ts` + `routes/routingRules.ts` (Zod-bound; Admin gate; delete `409` for guarded cases).
- **Tests:** `M31-BE-S3-H1..I1`.
- **Checkpoint:** service-layer test runs in the test DB; integration assert envelope shape; delete-guard exercised.

### Phase 4 — Tickets: create + list + detail (read paths)  *(BE-S4)*
- [ ] `lib/scoping.ts` — pure function turning `req.user` into a `where` clause for tickets.
- [ ] `lib/ids.ts` — `nextTicketCode()` (`HD-{YYYY}-{NNNNNN}`; sequence source decided here — leaning Postgres sequence).
- [ ] `services/AttachmentService.ts` + `lib/storage/local.ts` (LocalDiskAdapter under `./uploads`; multer disk storage in dev).
- [ ] `services/TicketService.ts` — `create`, `list(query, caller)`, `getById(id, caller)`.
- [ ] `routes/tickets.ts` — `POST /tickets` (multer + Zod), `GET /tickets`, `GET /tickets/:id`, `GET /tickets/:id/history`, `GET /attachments/:id`.
- **Tests:** `M31-BE-S4-H1`, `-E1..4`, `-X1..3`, `-I1`.
- **Checkpoint:** end-to-end create → list (scoped) → detail green; multer `413` triggered for a >10 MB blob.

### Phase 5 — State machine transitions (assign / forward / redirect / progress / close / severity)  *(BE-S5)*
- [ ] `lib/transitions.ts` — typed transition table: `from → to`, allowed roles, side-effects.
- [ ] `services/AssignmentService.ts` (Lead-only assign + reassign).
- [ ] `services/TicketService.ts` — `forward`, `redirect`, `startProgress`, `close`, `overrideSeverity`. Each runs **one Prisma transaction**: status read → guard → status write + `TicketEvent` insert + (optional) `Notification` insert; throws `ConflictError → 409` on stale status.
- [ ] `routes/tickets.ts` — `POST /:id/{assign,forward,redirect,progress,close}` + `PATCH /:id/severity`.
- **Tests:** `M31-BE-S5-H1..H4`, `-E1..3`, `-X1..4`, `-I1` (the X2 stale-state race uses two concurrent transactions in the test).
- **Checkpoint:** the full lifecycle integration test passes (SV create → Lead assign → Lead forward → Staff progress → Lead close), with one `TicketEvent` row + the expected notification per step.

### Phase 6 — Comments + attachments on comments + history endpoint  *(BE-S6)*
- [ ] `services/TicketService.ts` — `addComment(id, caller, body, files)` (attachments tied to `commentId`).
- [ ] `routes/tickets.ts` — `POST /:id/comments` (multer + Zod); `GET /:id/history` already in Phase 4.
- **Tests:** `M31-BE-S6-H1..I1`.
- **Checkpoint:** participant + Helpdesk can comment; outsider gets `403`; attachment row created + downloadable.

### Phase 7 — In-app notifications: store + list + mark-read  *(BE-S7)*
- [ ] `services/NotificationService.ts` — `insert(type, userId, ticketId, payload)` (used inside the transition transactions); `listForCaller(caller, paging)`; `markRead(id, caller)`.
- [ ] `routes/notifications.ts` — `GET /notifications`, `POST /notifications/:id/read`.
- **Wire lifecycle inserts** in Phase 5 transitions (close → requester, assign → agent, forward → dept staff, progress → requester). These were stubbed; this phase activates them.
- **Tests:** `M31-BE-S7-H1..I1`.
- **Checkpoint:** close → requester sees an unread `TICKET_CLOSED`; mark-read flips `readAt`; cross-user `403`.

### Phase 8 — Daily 09:00 reminder (bullmq + Vercel Cron)  *(BE-S8)*
- [ ] `lib/calendar.ts` — public holidays config + `isHolidaySkip(d)`.
- [ ] `jobs/daily-reminder.ts` — single handler: query backlog per agent (`Pending|Assigned|Redirected`, owned by agent), insert one `DAILY_REMINDER` per agent with dedupe key `reminder:{agentId}:{YYYY-MM-DD}` (Redis `SETNX` 24h TTL); skips if `isHolidaySkip(today)`.
- [ ] `worker.ts` — local-only: bullmq Worker on a repeatable cron `0 9 * * 1-5` (Asia/Ho_Chi_Minh).
- [ ] `routes/jobs.ts` — `POST /jobs/daily-reminder` guarded by `Authorization: Bearer $JOB_SECRET`; invokes the same handler.
- [ ] `vercel.json` — `crons: [{ path: '/jobs/daily-reminder', schedule: '0 2 * * 1-5' }]` *(UTC equivalent of 09:00 ICT)*; `routes` catch-all to `app.ts`.
- **Tests:** `M31-BE-S8-H1`, `-E1..3`, `-X1..2`, `-I1` — drive the handler directly with an injected clock; no real cron/queue under test.
- **Checkpoint:** local: `tsx worker.ts` registers the repeatable; integration test for the handler is green; the `POST /jobs/daily-reminder` route is `403` without the secret.

### Phase 9 — EventPublisher (logger adapter) + lifecycle events  *(BE-S9)*
- [ ] `lib/events/publisher.ts` — `EventPublisher` interface: `ticketCreated`, `ticketClosed` (extensible).
- [ ] `lib/events/logger-adapter.ts` — dev default; records to pino.
- [ ] `lib/events/qstash-adapter.ts` — prod stub (Upstash QStash) wired by `EVENT_PUBLISHER_DRIVER=qstash`.
- [ ] Wire publish calls into `TicketService.create` and `.close`. Failures are caught, logged, and queued for retry (bullmq locally / QStash retries in prod); **must not** roll back the ticket tx.
- **Tests:** `M31-BE-S9-H1..I1`.
- **Checkpoint:** sync publisher throw → API still `201/200`; missing env var → boot fails fast.

### Phase 10 — Analytics summary  *(BE-S10)*
- [ ] `services/AnalyticsService.ts` — single SQL via Prisma `$queryRaw` (counts grouped by severity / status / department / category; `avgHandlingDays` = `avg(extract(epoch from closedAt-createdAt)/86400)` for closed rows).
- [ ] `routes/analytics.ts` — `GET /analytics/summary` (Helpdesk / Admin / BGH only).
- **Tests:** `M31-BE-S10-H1..I1`.
- **Checkpoint:** seeded mix returns the exact counts; `SV → 403`.

### Phase 11 — Hardening, Vercel finalization, coverage
- [ ] `npm run lint && typecheck && build && test -- --coverage` — all green; coverage ≥ 80% on `src/`.
- [ ] `vercel.json` finalized; deploy-preview verifies `app.ts` handler boots and `/healthz` returns 200 *(not run in practice mode — documented).*
- [ ] Pick the prod attachment storage adapter (FP §K open item) and add the chosen adapter under `lib/storage/`.

## D. Cross-cutting / shared-code risks

- **`lib/transitions.ts`, `lib/scoping.ts`, `lib/envelope.ts`, middleware chain** — touched once in Phase 1/5 and then frozen. Edits here ripple across every test; treat as stable after their phase ships.
- **State-machine drift between FE and BE.** §C transition table is the spec; if the FE reports a status the BE can't reach, the BE is the authority — make the FE adapt.
- **`prisma/schema.prisma`** — additive only after Phase 2; future schema changes go through a separate migration + review.
- **EventPublisher failures must never roll back ticket tx** (Phase 9) — that risk is gated by an integration test (`-E1`).
- **Vercel vs local divergence**: only the reminder runtime differs. Keep the handler implementation single-sourced in `jobs/daily-reminder.ts` (both runtimes call it).

## E. Dependencies to add

- **Runtime:** `express`, `@prisma/client`, `zod`, `multer`, `bullmq`, `ioredis`, `helmet`, `express-rate-limit`, `pino`, `pino-http`, `pino-pretty`, `cors`, `@paralleldrive/cuid2`, `date-fns`, `date-fns-tz`, `passport`, `passport-google-oauth20`.
- **Dev/test:** `typescript`, `tsx`, `@types/node`, `@types/express`, `@types/multer`, `@types/supertest`, `vitest`, `supertest`, `@vitest/coverage-v8`, `prisma`, `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-config-prettier`, `prettier`.

## F. Rollback / safety

- New standalone service. **Practice mode stops at Step 7 (Test) — no commit/PR/deploy**, so no real rollback drill.
- Prisma migration `0001_create_m31_helpdesk` is paired with `.down.sql` (drops M31 tables only, no shared tables touched).
- Feature flag **`HELPDESK_ENABLED`** at `app.ts`-level gate: when `false`, every route returns `503` (kill-switch without redeploy).
- The bullmq repeatable job + the Vercel cron can both be disabled independently (queue drain locally; `vercel.json` `crons:` removed in prod).

## G. Traceability (phase → stories → test IDs)

| Phase | Stories | Test IDs |
|---|---|---|
| 1 | BE-S1 | `M31-BE-S1-*` |
| 2 | BE-S2 | `M31-BE-S2-*` |
| 3 | BE-S3 | `M31-BE-S3-*` |
| 4 | BE-S4 | `M31-BE-S4-*` |
| 5 | BE-S5 | `M31-BE-S5-*` |
| 6 | BE-S6 | `M31-BE-S6-*` |
| 7 | BE-S7 | `M31-BE-S7-*` |
| 8 | BE-S8 | `M31-BE-S8-*` |
| 9 | BE-S9 | `M31-BE-S9-*` |
| 10 | BE-S10 | `M31-BE-S10-*` |
| 11 | — *(hardening)* | full suite |

---

*Next per process: **Step 6** — `/sc:implement` each phase's tasks as small units (read every line; run tests as we go). Confirm the §A decisions first (especially the §A.7 Vercel block).*
