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
4. **Demo auth**: email + bcrypt-hashed password (per-persona, seeded) → JWT in `HttpOnly Secure SameSite=None` cookie, 8 h lifetime, no refresh. `cookie-parser` + `cors({ credentials: true, origin })` on the app; rate-limit on `/auth/login`. Identity + role decoded from the JWT on every request (FP §F Identity contract). **No new `username` column** — the existing `User.email` (unique) is the login identifier; only `passwordHash` is added to the schema.
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
      rateLimitLogin.ts          # express-rate-limit instance for /auth/login
    routes/
      healthz.ts  auth.ts        # POST /auth/login, POST /auth/logout, GET /auth/me
      categories.ts  routingRules.ts  tickets.ts  notifications.ts
      analytics.ts  jobs.ts      # POST /jobs/daily-reminder (Vercel-Cron-invoked)
    services/
      AuthService.ts             # verifyCredentials, signJwt, cookieOptions, parseJwt
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
- [ ] `.env.example` (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `CORS_ORIGIN`, `JOB_SECRET`, `STORAGE_DRIVER`, `EVENT_PUBLISHER_DRIVER`, `HELPDESK_ENABLED`).
  - **Deployed reality:** prod `DATABASE_URL` is NeonDB; the docker-compose `localhost:5433` line is dev-only. `CORS_ORIGIN` ships with `https://umshelpdesk.vercel.app,http://localhost:3000`. **No `COOKIE_DOMAIN`** — the cookie is host-only on `ums-helpdesk-api.vercel.app` because `.vercel.app` is on the Public Suffix List and a parent-domain cookie is impossible.
- [ ] `.github/workflows/ci.yml`: spin up the compose, `prisma migrate deploy`, `npm run lint && typecheck && test -- --coverage && build`.
- **Checkpoint:** `npm run typecheck` clean; an empty `tests/unit/sanity.test.ts` passes via `vitest run`.

### Phase 1 — Foundation: env, logger, prisma, envelope, requestId, auth, rbac, error, healthz  *(BE-S1)*
- [ ] `lib/logger.ts` (pino + pino-http; redacts `authorization`, `x-mock-*`, `password`).
- [ ] `lib/prisma.ts` (singleton; `log: ['warn','error']`).
- [ ] `lib/envelope.ts` + `lib/errors.ts` (`AppError`, `ValidationError`, `ConflictError`, etc., with codes + status).
- [ ] `config/env.ts` (Zod schema; reject on boot if invalid).
- [ ] `middleware/requestId.ts` (header or generate; attaches `req.id`).
- [ ] `middleware/auth.ts` — read `req.cookies.ums_session`, `jwt.verify` with `JWT_SECRET`, attach `req.user = { id, role, departmentId }`. Reject (`401 unauthenticated`) on missing / invalid / expired cookie. Skipped for `/healthz` and `POST /auth/login`.
- [ ] `middleware/rbac.ts` (capability table; throws `ForbiddenError`).
- [ ] `middleware/zodValidate.ts` (per-route Zod parse → `ValidationError`).
- [ ] `middleware/error.ts` (final handler; shapes envelope; logs with `requestId`).
- [ ] `routes/healthz.ts` (public, returns `{ status:'ok' }`).
- [ ] `app.ts` (build the Express instance; **mount order: `helmet` → `cors({ credentials: true, origin: env.CORS_ORIGIN.split(',') })` → `cookie-parser` → `requestId` → `auth` (after `/auth/login`+`/healthz` exclusions) → router**); export default for Vercel handler. **Replaces the current bare `app.use(cors())`** at [`src/app.ts:37`](../../src/app.ts#L37) — that line currently emits no `Access-Control-Allow-Credentials: true`, so the FE's cookie-bearing requests will be blocked by the browser until this lands.
- [ ] `index.ts` (`if (!process.env.VERCEL) app.listen(PORT)` — local only).
- **Tests:** `M31-BE-S1-H1`, `-E1..2`, `-X1..2`, `-I1` — all via supertest against `app.ts`.
- **Checkpoint:** `vitest run` green; `tsc --noEmit` clean; `npm run build` produces `dist/`.

### Phase 2 — Prisma schema + migration + seed  *(BE-S2)*
- [ ] `prisma/schema.prisma` — models per FP §E (PascalCase enums; `@@map` snake_case; cuid IDs; indexes). **`User` model gains only `passwordHash String?`** — `email` (unique) is the login identifier, `displayName` is what shareholders see; existing `ssoSubject` stays for the future SSO swap.
- [ ] `0001_create_m31_helpdesk/migration.sql` (generated then committed) + `migration.down.sql` (hand-written DROP set).
- [ ] `prisma/seed.ts` — upsert 5 departments, 6 categories, default routing rules, **13 demo personas** (one row per persona — `u-sv-1`, `u-gv-1`, `u-nv-1`, `u-agent-1`, `u-agent-2`, `u-lead-1`, `u-deptstaff-fin-1`, `u-deptstaff-it-1`, `u-deptstaff-aca-1`, `u-deptstaff-fac-1`, `u-deptstaff-hr-1`, `u-admin-1`, plus one extra GV) with `bcryptjs.hash(password, 10)`. Passwords + display names live in a `seed-personas.ts` array so FE credential-helper note can import the *same* list.
- [ ] `tests/helpers/test-db.ts` — `truncate ... cascade` for M31 tables; `applyMigrations()`; `seedFixtures()`.
- [ ] `tests/helpers/login-as.ts` — `loginAs(app, { email, password })` helper that hits `POST /auth/login` and returns the `Set-Cookie` array for downstream supertest calls. Existing `X-Mock-*` header tests stay; this helper is purely additive.
- **Tests:** `M31-BE-S2-H1..I1` (migration + seed idempotency + down-script scope + post-seed `GET /categories`; **persona-seed test asserts all 13 rows present and `bcrypt.compare(plaintext, passwordHash) === true`**).
- **Checkpoint:** `prisma migrate dev` → `prisma migrate reset` → green test run.

### Phase 2.5 — Demo auth endpoints + middleware  *(BE-S11 — new)*

This phase is purely additive — existing tests keep using `X-Mock-*` headers via the non-prod fallback in `authMiddleware`. New tests that want to exercise the real cookie path use `loginAs(app, persona)`.

- [ ] `services/AuthService.ts`
  - `verifyCredentials(prisma, email, password)` — `prisma.user.findFirst` (email lowered + `isActive`) → `bcrypt.compare`; returns the `SessionUser` shape or throws `UnauthenticatedError` with the opaque message.
  - `signJwt(user)` → `jwt.sign({ sub, role, departmentId }, JWT_SECRET, { expiresIn: '8h' })`.
  - `cookieOptions()` → `{ httpOnly: true, secure: true, sameSite: 'none', maxAge: 8*60*60*1000, path: '/' }` — **no `domain` attribute** (host-only on `ums-helpdesk-api.vercel.app`; `.vercel.app` is on the Public Suffix List so a parent-domain cookie is impossible). In dev (`NODE_ENV !== 'production'`): `secure: false` + `sameSite: 'lax'` so the cookie works on `http://localhost`.
  - `parseJwt(token)` — `jwt.verify`; returns the decoded claims or throws.
- [ ] `middleware/rateLimitLogin.ts` — `express-rate-limit` (5 attempts / 15 min / IP, skipSuccessfulRequests).
- [ ] `routes/auth.ts`
  - `POST /auth/login` — Zod body `{ email: z.string().email(), password: z.string().min(1) }`; call `verifyCredentials` → `signSessionJwt` → `res.cookie('ums_session', token, sessionCookieOptions())` → respond envelope `{ user: { id, displayName, role, departmentId } }`. On failure → opaque `401 { code: 'unauthenticated' }`. Malformed body → `422 validation_error` with `fields.email`/`fields.password`.
  - `POST /auth/logout` — `res.clearCookie('ums_session', cookieOptions())`; idempotent `200 {}`.
  - `GET /auth/me` — `req.user` already populated by `middleware/auth.ts`; return envelope `{ user: { id, fullName, role, departmentId } }`.
- [ ] Wire `app.ts`: register `POST /auth/login` BEFORE the global auth middleware (it cannot require a cookie); `/auth/logout` and `/auth/me` go after.
- [ ] Update `JWT_SECRET` env validation in `config/env.ts` — reject boot if missing or < 32 chars.
- **Tests:** `M31-BE-S11-H1..I1` (login OK, me OK, wrong-password opaque 401, rate-limit, no-cookie 401, malformed-body 422, logout idempotent, full round-trip).
- **Checkpoint:** `loginAs('u-sv-1')` helper returns a usable `Set-Cookie`; supertest can hit `GET /tickets` with that cookie and get 200; the same call without the cookie returns 401.

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

### Phase 12 — Google OAuth login  *(BE-S12 — new)*

Adds "Sign in with Google" alongside the email/password flow. Authorization Code Flow, **BE-mediated** — the FE just kicks off a redirect; the BE handles the OAuth round-trip, verifies the ID token, upserts the user, and issues the **same `ums_session` JWT cookie** as Phase 2.5. Cookie/session machinery, RBAC, and FE consumers are unchanged.

**Decisions (locked):**
- **Email-domain allowlist**: `@ums.edu.vn`, `@dau.edu.vn`. Any other domain → 403 at the callback (clear error page on FE).
- **First-time sign-in**: auto-create a new `User` row with `role: 'SV'`. Admin elevates later through `M02 Phân quyền` (out of scope here).
- **Account linking**: if the Google email matches an existing user (e.g., a seeded persona like `sv01@ums.edu.vn`), link the accounts — set `googleId` on the existing row, keep their role / departmentId / history intact.

**Phase 12.A — schema + env + deps**
- [ ] `prisma/schema.prisma` — `User` gains `googleId String? @unique` + `avatarUrl String?`. Both nullable; existing rows untouched.
- [ ] `prisma/migrations/20260605000000_user_google_columns/{migration.sql,migration.down.sql}` — additive `ADD COLUMN` only.
- [ ] `config/env.ts` — Zod-validate `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `FE_ORIGIN` (all required when `AUTH_MODE=jwt`).
- [ ] Deps: add `google-auth-library` (drop the never-used `passport` + `passport-google-oauth20`).
- [ ] `.env.example` + Vercel env: document the four new vars + the Google Cloud setup steps.

**Phase 12.B — service + routes**
- [ ] `services/AuthService.ts`
  - `verifyGoogleIdToken(idToken)` — uses `OAuth2Client.verifyIdToken({ audience: GOOGLE_CLIENT_ID })`; returns the verified payload or throws `UnauthenticatedError`.
  - `upsertGoogleUser({ googleId, email, name, picture })` — domain allowlist check → lookup by `googleId` → fall back to lookup by `email` (link path) → fall back to create-new (role: SV). Returns `SessionUser`.
- [ ] `routes/auth.ts`
  - `GET /auth/google` — `?next=` honored. Generates signed `state = jwt.sign({ next, nonce }, JWT_SECRET, { expiresIn: '10m' })`, sets `Set-Cookie: google_oauth_state=<state>; HttpOnly; SameSite=Lax; Path=/auth/google/callback; Max-Age=600`, then `302` to Google's authorization URL with `state` in the query.
  - `GET /auth/google/callback` — double-submit verify (cookie `state` === URL `state`), `jwt.verify(state)` → extract `next`; exchange `code` for tokens via the OAuth client; verify ID token; upsert user; sign JWT; set `ums_session` cookie; clear the `google_oauth_state` cookie; `302` to `${env.FE_ORIGIN}${sanitizedNext}`.
- [ ] `app.ts` — mount the auth router as-is (no global-auth middleware needed for the two new routes; they're public-by-design).
- [ ] `openapi/{paths,components}.ts` — document both routes with their redirect status codes + the `googleId` field on the SessionUser schema.

**Phase 12.C — tests + local run**
- [ ] `tests/unit/auth-service-google.test.ts` — `upsertGoogleUser` paths (new user / existing-by-googleId / existing-by-email-linking / rejected-domain). Mock `verifyGoogleIdToken` with `vi.mock`.
- [ ] `tests/integration/auth-google.test.ts` — `/auth/google` returns `302` + `Set-Cookie: google_oauth_state`; `/auth/google/callback` with a mocked verifier returns `302` to `${FE_ORIGIN}` + `Set-Cookie: ums_session` + clears state cookie. Includes mismatched-state, expired-state, rejected-domain, code-exchange-failure cases.
- [ ] Local: apply migration to docker-compose Postgres → `npm test` → green.

**Phase 12.D — production rollout** *(blocks on user)*
- [ ] User: Google Cloud Console — create OAuth client, allowlist redirect URIs (`https://ums-helpdesk-api.vercel.app/auth/google/callback`, `http://localhost:4000/auth/google/callback`).
- [ ] User: Vercel env vars on the BE project — add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `FE_ORIGIN`.
- [ ] Apply migration to NeonDB.
- [ ] Push → Vercel deploy → smoke test `curl -i https://ums-helpdesk-api.vercel.app/auth/google` → expect `302` to `accounts.google.com`.

**Phase 12 risk register**
- **Open-redirect via `next`** → sanitize: must start with `/`, can't start with `//`, no scheme. Reject anything else, fall back to `/`.
- **State CSRF** → double-submit cookie + signed JWT state means both the cookie AND the URL state are needed AND they must match a server-issued signed value. An attacker forging only one side fails.
- **Cross-origin Set-Cookie on the callback** → same as Phase 2.5: the cookie is set on the BE origin, browser sends it cross-origin to the BE on subsequent requests via `SameSite=None; Secure`. The `res.redirect()` to the FE is just navigation; the FE's first `GET /auth/me` round-trip reads the session.
- **Email-domain spoofing via `email_verified=false`** → reject any payload where `email_verified !== true`. Google sets this on every ID token.
- **Account-linking takeover** → when a Google email matches an existing user, we set `googleId` on that row. If the existing row is an Admin/Lead, a Google sign-in from a matching email would inherit that role. Mitigation: the email allowlist (`@ums.edu.vn` / `@dau.edu.vn`) is the perimeter — anyone with a `@ums.edu.vn` Google account is trusted as that identity. Document this loud.

### Phase 13 — Admin user directory  *(BE-S13 — new)*

Read-only Admin view of every persisted `User`. Lets the Admin see who's in the system, how they signed up (password vs Google-linked), and which department + role they hold. **No mutations** — per the helpdesk-scope memory, departments / users / faculties are owned by other UMS modules; we only render what the BE has.

**Decisions (locked):**
- **List + per-user detail + filters + pagination.** Filters: `role`, `departmentId`, `search` (case-insensitive `displayName` OR `email` `ILIKE`).
- **Fields per row**: `id`, `email`, `displayName`, `role`, `department { id, code, name } | null`. Sensitive fields stay server-side — never expose `passwordHash`, `ssoSubject`, or the raw `googleId` claim.
- **Authorization**: Admin only. All other roles → `403 forbidden`.

**Phase 13.A — service + routes + RBAC**
- [ ] `services/UserService.ts` — `list({ role?, departmentId?, search?, page, pageSize })` returns `{ items, page, pageSize, total }`; `getById(id)` returns the same DTO shape (404 if missing). Pure read queries; no transactions.
- [ ] `lib/dto.ts` — `USER_INCLUDE` (`department: true`) + `toUserDTO` (project out `passwordHash`, `ssoSubject`, `googleId`).
- [ ] `routes/users.ts` — `GET /users` (Zod-validated query) + `GET /users/:id`. Both `requireAuth` + `requireRole('Admin')`.
- [ ] `app.ts` — mount `usersRouter`.

**Phase 13.B — tests**
- [ ] `tests/integration/users.test.ts` — `M31-BE-S13-H1` Admin list returns all seeded personas; `H2` `?role=DeptStaff` filters; `H3` `?search=admin` matches; `H4` pagination (`?page=2&pageSize=2`); `H5` detail by id; `X1` SV → 403; `X2` Lead → 403 (Admin-only); `X3` detail 404 for unknown id; `X4` `?role=Invalid` → 422; the DTO never includes `passwordHash` or `ssoSubject`.
- [ ] `tests/service/user-service.test.ts` — unit-ish coverage of the where-clause builder for each filter combination (driven against the test DB so we don't mock Prisma).

**Phase 13.C — OpenAPI**
- [ ] `openapi/components.ts` — `User` schema (DTO shape) + `UserListResponse` (`items[]` + paging).
- [ ] `openapi/paths.ts` — document both routes with examples.

**Phase 13 risk register**
- **PII exposure** — never include `passwordHash`, `ssoSubject`, or raw `googleId` in the response. The DTO projection is the perimeter. A test asserts each forbidden key is absent.
- **Search query injection** — Prisma's `contains` filter takes raw strings safely (parameterized SQL underneath). No risk of SQL injection.

## D. Cross-cutting / shared-code risks

- **`lib/transitions.ts`, `lib/scoping.ts`, `lib/envelope.ts`, middleware chain** — touched once in Phase 1/5 and then frozen. Edits here ripple across every test; treat as stable after their phase ships.
- **State-machine drift between FE and BE.** §C transition table is the spec; if the FE reports a status the BE can't reach, the BE is the authority — make the FE adapt.
- **`prisma/schema.prisma`** — additive only after Phase 2; future schema changes go through a separate migration + review.
- **EventPublisher failures must never roll back ticket tx** (Phase 9) — that risk is gated by an integration test (`-E1`).
- **Vercel vs local divergence**: only the reminder runtime differs. Keep the handler implementation single-sourced in `jobs/daily-reminder.ts` (both runtimes call it).

## E. Dependencies to add

- **Runtime:** `express`, `@prisma/client`, `zod`, `multer`, `bullmq`, `ioredis`, `helmet`, `express-rate-limit`, `pino`, `pino-http`, `pino-pretty`, `cors`, `cookie-parser`, `jsonwebtoken`, `bcryptjs`, `google-auth-library`, `@paralleldrive/cuid2`, `date-fns`, `date-fns-tz`.
- **Dev/test:** `typescript`, `tsx`, `@types/node`, `@types/express`, `@types/multer`, `@types/cookie-parser`, `@types/jsonwebtoken`, `@types/bcryptjs`, `@types/supertest`, `vitest`, `supertest`, `@vitest/coverage-v8`, `prisma`, `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-config-prettier`, `prettier`.

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
| 2.5 | BE-S11 | `M31-BE-S11-*` |
| 13 | BE-S13 | `M31-BE-S13-*` |
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
