# Test Design (BE) — M31 Helpdesk / Ticket

| Field | Value |
|---|---|
| Module | **M31 — Helpdesk / Ticket** — Back-end |
| Sources | `feat-helpdesk-api/docs/brief.md`, `feat-helpdesk-api/docs/feature-plan.md` (§A decisions, §C state machine, §F API contract, §M Stories) |
| Step | Process Step 4 — Test design (`/sc:test --design --persona-qa`) |
| Stack under test | Node 20 · TypeScript · Express · Prisma 5 (Postgres) · Zod · bullmq · pino |
| Min per Story (Bảng 5.1) | ≥1 Happy · ≥2 Edge · ≥2 Error · ≥1 Integration |
| Coverage gate (Step 7) | ≥ 80% on new BE code |

> The **design** doc — Given-When-Then cases. Executable stubs (`describe/it.todo`) land against real services/routes when the project is scaffolded in **Step 6**.

---

## 1. Tooling & test layers

| Layer | Tool | Scope |
|---|---|---|
| Unit / logic | **Vitest** | pure helpers — status / severity mappers, scoping rules, Zod schemas, envelope/error shapers, holiday calendar, dedupe-key builder, code generator. |
| Service layer | **Vitest + Prisma client** against a **test Postgres DB** (the same `docker-compose.yml` Postgres on a separate schema) | TicketService / AssignmentService / NotificationService etc. — write a row, assert DB state + side-effects (events, notifications). A `tests/helpers/test-db.ts` truncates tables between tests; transactions tested end-to-end. |
| Integration (HTTP) | **supertest** against the `app.ts` Express factory + test DB + a fake bullmq / EventPublisher | full request lifecycle — middleware chain, RBAC, Zod, envelope, status codes, DB side-effects. |
| Background job | **Vitest** driving the handler in `jobs/daily-reminder.ts` directly with seeded data + injected clock | reminder cron logic; idempotency; holiday-skip; per-agent backlog SQL. |

**Folder layout** (mirrors `feat-admission-plan/tests`): `tests/unit/`, `tests/service/`, `tests/integration/`, `tests/helpers/`.
**Test ID scheme:** `M31-BE-S<n>-<H|E|X|I><m>` (H=happy, E=edge, X=error, I=integration).

## 2. Cross-cutting expectations (asserted across stories)

- **Envelope on every response** — success: `{ data, error: null, requestId }`; failure: `{ data: null, error: { code, message, fields? }, requestId }`. `requestId` always non-empty and matches the `X-Request-Id` response header.
- **Error code mapping** — `400` Zod parse · `401` no/invalid SSO · `403` RBAC/ownership · `404` not found · `409` state-machine conflict · `413` attachment too large · `422` business validation · `5xx` reserved for real server errors.
- **Server-derived scoping** — every list query filters by the caller's role/identity; any `departmentId` sent by the client is **ignored** by the BE.
- **Transaction atomicity** — when a transition fires (status change + `TicketEvent` + sometimes `Notification`), a forced failure on the last write rolls back the lot (no half-applied transitions).
- **Optimistic guard** — every transition reads current status inside the tx; if it changed between request arrival and the tx, returns `409` and writes nothing.
- **Idempotent jobs** — the daily reminder dedupe key prevents a second invocation on the same day from creating duplicate notifications.
- **Observability** — every response carries the `X-Request-Id` matching the pino log line for the request; no PII or SSO secret in logs.

## 3. Test cases by Story

### BE-S1 — Project scaffold + envelope + healthz + auth/RBAC middleware
- **H1** — GIVEN the app is started, WHEN `GET /healthz`, THEN `200` with `{ data: { status: 'ok' }, error: null, requestId }`.
- **E1** — GIVEN `GET /healthz` with no SSO headers, THEN still `200` (healthz is public).
- **E2** — GIVEN a protected route, WHEN called with all mock headers, THEN `req.user = { id, role, departmentId }` and the handler runs.
- **X1** — GIVEN `GET /tickets` without `X-Mock-User-Id`, THEN `401` with envelope `error.code='unauthenticated'`.
- **X2** — GIVEN `POST /admin/categories` as role `SV`, THEN `403` with envelope `error.code='forbidden'`.
- **I1** *(supertest)* — middleware chain end-to-end: a thrown route error is shaped by the error middleware into the envelope, with the same `requestId` that's in the response header.

### BE-S2 — Prisma schema + migration + seed
- **H1** — GIVEN an empty DB, WHEN `prisma migrate deploy` runs, THEN all M31 tables exist with the expected indexes; the seed loads departments + 6 categories + their default routing rules.
- **E1** — GIVEN migrations have run once, WHEN re-run, THEN no-op (idempotent).
- **E2** — GIVEN the seed has run, WHEN re-run, THEN no duplicates (upserts on `(code)` / `(name)`).
- **X1** — GIVEN `0001_create_m31_helpdesk.down.sql` runs, THEN only M31 tables are dropped (no shared tables touched).
- **X2** — GIVEN a row exists, WHEN trying to drop the table without cascade, THEN the down script handles it explicitly.
- **I1** — after seed, `GET /categories` returns exactly the 6 seeded categories with their parent/active flags correct.

### BE-S3 — Categories + routing-rules CRUD (Admin)
- **H1** — Admin `POST /categories { name:'X' }` → `201` category DTO; `GET /categories` includes it.
- **E1** — Admin `POST /categories { name:'X', parentId }` → child created; tree shape preserved.
- **E2** — Admin `POST /routing-rules { categoryId, departmentId, isDefault:true }` → any prior default for the same category is unset (same tx).
- **X1** — `POST /categories` as `SV` → `403`.
- **X2** — `POST /categories` with name already taken → `422` `fields.name='Tên danh mục đã tồn tại'`.
- **X3** — `DELETE /categories/:id` with children present → `409` `error.code='delete_guard'` (block).
- **I1** — Admin creates category + routing → `GET /tickets`-related lookup uses the new routing default on the next `forward`.

### BE-S4 — Ticket create + list + detail (read paths)
- **H1** — SV `POST /tickets` (multipart, severity=High) → `201` TicketDTO; DB has `status=Pending` + `TicketEvent[Created]`; one `EventPublisher.ticketCreated` call.
- **E1** — SV `GET /tickets` returns **only** their own (server-derived scoping); a HelpdeskLead sees all.
- **E2** — `GET /tickets?status=open` returns the four non-Closed statuses.
- **E3** — `GET /tickets?status=Pending,Assigned` filters to that subset; `?severity=Critical,High` likewise.
- **E4** — pagination: `pageSize=2&page=2` returns the next two; `total` is the unpaged count.
- **X1** — `POST /tickets` missing `severity` → `422` `fields.severity`.
- **X2** — `POST /tickets` with a 12 MB attachment → `413` (multer limit hit before service).
- **X3** — SV `GET /tickets/:id` of another user's ticket → `403` (scoping enforced server-side; client `departmentId` ignored if sent).
- **I1** *(supertest end-to-end)* — SV creates ticket → SV `GET /tickets` shows it → another SV's `GET /tickets` does not → Lead's `GET /tickets` does.

### BE-S5 — State machine transitions (assign / forward / redirect / progress / close / severity)
- **H1** — Lead `POST /:id/assign { agentId }` (target=HelpdeskAgent) → `200`; `helpdeskAssigneeId` set; `TicketEvent[AgentAssigned]`; `Notification[TICKET_ASSIGNED]` to agent.
- **H2** — Helpdesk `POST /:id/forward { departmentId }` → status `Pending → Assigned`; `TicketEvent[Forwarded]`; `Notification[TICKET_FORWARDED]` to dept staff.
- **H3** — Dept Staff (own dept) `POST /:id/progress` → `Assigned → InProgress`; `TicketEvent[Started]`; `Notification[STATUS_CHANGED]` to requester.
- **H4** — Lead `POST /:id/close` → `→ Closed`; `closedAt` set; `Notification[TICKET_CLOSED]` to requester; `EventPublisher.ticketClosed`.
- **E1** — Lead reassigns the agent → `helpdeskAssigneeId` updated; history has both AgentAssigned events.
- **E2** — Helpdesk `POST /:id/redirect { departmentId, reason }` from `Assigned` → new `routedDepartmentId`; `TicketEvent[Redirected]` carries `from→to`.
- **E3** — Helpdesk `PATCH /:id/severity { severity:'Low' }` → updated; `TicketEvent[SeverityChanged]`.
- **X1** — SV `POST /:id/close` → `403` (close authority = Helpdesk only).
- **X2** — *Stale state* race: A and B both POST `/forward` on a `Pending` ticket; the second sees `status=Assigned` inside the tx → returns `409` and **writes nothing** (no extra event, no notification).
- **X3** — `POST /:id/progress` on a ticket in `Pending` → `409` (must be `Assigned`).
- **X4** — `POST /:id/forward` on a `Closed` ticket → `409` (terminal).
- **I1** *(supertest end-to-end)* — full lifecycle: SV create → Lead assign → Lead forward → Staff progress → Lead close. After each step, the DB has the expected status + a new `TicketEvent` row + the expected `Notification` row.

### BE-S6 — Comments + attachments + history endpoint
- **H1** — Requester `POST /:id/comments { body }` → `201` comment DTO; `TicketEvent[Commented]` appended.
- **E1** — Dept Staff (assigned dept) `POST /:id/comments` → `201`.
- **E2** — `POST /:id/comments` with an image attachment → `Attachment` row created with `commentId`, accessible via `GET /attachments/:id` (authz-checked).
- **X1** — A non-participant `POST /:id/comments` → `403`.
- **X2** — `POST /:id/comments { body: '' }` → `422` `fields.body`.
- **I1** — `GET /:id/history` returns events in `createdAt` order: `Created`, then `AgentAssigned`, then `Forwarded`, then `Commented`.

### BE-S7 — In-app notifications: store + list + mark-read + lifecycle inserts
- **H1** — On `close`, `Notification[TICKET_CLOSED]` inserted for requester → `GET /notifications` returns it unread, newest-first.
- **E1** — On `assign`, `Notification[TICKET_ASSIGNED]` inserted for the assigned agent.
- **E2** — On `forward`, `Notification[TICKET_FORWARDED]` inserted for each dept-staff member of the routed dept.
- **E3** — `POST /notifications/:id/read` sets `readAt`; subsequent `GET` still returns it but sorted after unread.
- **X1** — `GET /notifications` returns only the caller's own (server-side scoping).
- **X2** — `POST /notifications/:id/read` on another user's notification → `403`.
- **I1** *(supertest end-to-end)* — Lead closes → requester's `GET /notifications` includes the close notice → marks it read → unread count decrements.

### BE-S8 — Daily 09:00 reminder (bullmq locally, Vercel Cron in prod)
- **H1** — invoke the handler with seeded backlog: one agent owns 3 tickets in `{Pending, Assigned, Redirected}` → exactly one `Notification[DAILY_REMINDER]` for that agent, payload listing the 3 with `severity` + `ageDays`.
- **E1** — agent with **zero** backlog → no notification.
- **E2** — agent backlog includes `InProgress`/`Closed` → those are **excluded** from the payload (v1 spec: `{Pending,Assigned,Redirected}` only).
- **E3** — invoked on a date in the **holiday calendar** → no notifications created.
- **X1** — handler invoked **twice on the same date** → dedupe key prevents the second insert; only one notification per agent per day.
- **X2** — `ageDays` computed against an injected fixed clock for determinism (asserts `today - createdAt` integer days).
- **I1** *(integration)* — seed 3 agents with mixed backlogs (0 / 2 / 4 tickets) → run the handler → assert per-agent notification rows and the exact payload contents.

### BE-S9 — EventPublisher (logger adapter) + ticket lifecycle events
- **H1** — On `POST /tickets`, `EventPublisher.ticketCreated` is called with `{ ticketId, code, severity, requesterId, createdAt }`; the logger adapter records the call.
- **E1** — Publisher throws → the API still returns the original `201`; the failure is logged + queued for retry (the surrounding ticket tx is **not** rolled back).
- **E2** — Retry policy: a transient publisher failure followed by success on attempt 2 results in exactly one downstream emission.
- **X1** — A misconfigured publisher (missing env var) → boot-time `env.ts` Zod validation rejects → process exits with a clear error message.
- **X2** — Publisher throws synchronously → caught at the EventPublisher boundary; no error propagates to the HTTP response.
- **I1** *(integration)* — Lead closes a ticket → the publisher receives a `ticketClosed` event matching the ticket; logger adapter records the call shape.

### BE-S11 — Demo auth (login / logout / me) and cookie-JWT middleware

- **H1** — Seeded persona `POST /auth/login { email:'sv01@ums.edu.vn', password:'<seeded>' }` → `200`; envelope `{ data: { user: { id, role, displayName, departmentId } } }`; response sets the `ums_session` cookie (`HttpOnly`, `Secure`, `SameSite=None`, `Max-Age≈28800`).
- **H2** — `GET /auth/me` with the cookie → `200`; same user shape as login. `POST /auth/logout` then clears the cookie (`Max-Age=0`); a follow-up `GET /auth/me` → `401`.
- **E1** — Wrong password → `401` `error.code='unauthenticated'` `error.message='Sai email hoặc mật khẩu'`. The same opaque message for an unknown email (no user enumeration).
- **E2** — Login is rate-limited: ≥5 failed attempts from the same IP in 60s → `429` `error.code='too_many_requests'`. Successful login resets the counter.
- **E3** — `GET /tickets` with no cookie → `401`; with an expired/tampered cookie → `401` `error.code='unauthenticated'` (no detail leaked). Healthz and `/auth/login` itself remain reachable.
- **X1** — `POST /auth/login` with malformed body (missing field, bad email format) → `422` `fields.{email|password}`.
- **X2** — Logout with no cookie → `200` (idempotent — never `401` on logout).
- **I1** *(supertest)* — full round-trip: login → cookie set → `GET /auth/me` returns the user → `POST /tickets` succeeds with the cookie → logout → `GET /auth/me` returns `401` → `POST /tickets` returns `401`.

### BE-S10 — Analytics summary endpoint
- **H1** — Lead `GET /analytics/summary` → returns `{ total, open, closed, avgHandlingDays, bySeverity, byStatus, byDepartment, byCategory }` shaped per the FE contract.
- **E1** — Empty DB → all counts zero; `avgHandlingDays` is `0` or `null` and documented (decide once at impl).
- **E2** — Mixed seed (3 Closed + 4 open) → `closed=3`, `open=4`, and `byStatus` reflects the split.
- **X1** — `SV GET /analytics/summary` → `403` (not in the allow-list).
- **X2** — Aggregation error (forced via a Prisma mock) → `500` with envelope `error.code='analytics_failed'` (no stack leaked).
- **I1** *(supertest)* — seed 5 tickets across 2 categories, 3 departments, 2 severities → `GET /analytics/summary` returns the exact counts.

## 4. Coverage matrix (min-count compliance)

| Story | Happy | Edge | Error | Integration | Meets Bảng 5.1 |
|---|---|---|---|---|---|
| BE-S1 | 1 | 2 | 2 | 1 | ✅ |
| BE-S2 | 1 | 2 | 2 | 1 | ✅ |
| BE-S3 | 1 | 2 | 3 | 1 | ✅ |
| BE-S4 | 1 | 4 | 3 | 1 | ✅ |
| BE-S5 | 4 | 3 | 4 | 1 | ✅ |
| BE-S6 | 1 | 2 | 2 | 1 | ✅ |
| BE-S7 | 1 | 3 | 2 | 1 | ✅ |
| BE-S8 | 1 | 3 | 2 | 1 | ✅ |
| BE-S9 | 1 | 2 | 2 | 1 | ✅ |
| BE-S10 | 1 | 2 | 2 | 1 | ✅ |
| BE-S11 | 2 | 3 | 2 | 1 | ✅ |

**Totals:** 15 happy · 28 edge · 26 error · 11 integration = **80 BE test cases**, every Story meeting the minimum.

## 5. Open testing questions

- **Vercel-mode tests for §G:** keep the cron handler unit-/integration-testable directly (BE-S8 cases) so the same suite covers both runtimes. We do not test Vercel's cron scheduler itself.
- **Reminder backlog set** *(ties to FP §K open item)*: BE-S8-E2 assumes the v1 exclusion of `InProgress`. If §K resolves to include `InProgress`, that edge becomes a happy case and a new edge is added.
- **`avgHandlingDays` on empty DB**: BE-S10-E1 lists `0 or null` — decide at Step 6 and lock the case.
- **Network/Upstash error simulation** for the Vercel queued path: deferred to Step 5/6 once the adapter is picked.

---

*Traceability: BE Brief → BE Feature Plan §M Stories (BE-S1…BE-S10) → these test cases (`M31-BE-S*`). Next per process: **Step 5** — `/sc:workflow --detail --persona-architect` (implementation plan) before any BE code.*
