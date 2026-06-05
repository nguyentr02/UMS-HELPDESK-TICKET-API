# Feature Plan (BE) — M31 Helpdesk / Ticket

| Field | Value |
|---|---|
| Module | **M31 — Helpdesk / Ticket** — Back-end |
| Sources | `feat-helpdesk-api/docs/brief.md`, `feat-helpdesk-ticket/docs/feature-plan.md` (prior round — API §5, data model §4) |
| Step | Process Step 3 — Feature Plan (`/sc:design --type api --persona-architect`) |
| Stack | Node 20 · Express 4 · Prisma 5 (Postgres) · Zod · passport (SSO) · multer · bullmq (Redis) · pino · vitest |
| Reference repo | `feat-admission-plan/` — mirrored layout/tooling |
| Output of this step | **This document only** — no code yet (that is Step 6 `/sc:implement`) |

---

## A. Plan decisions (defaults — flag any to change before Step 6)

1. **Single Express app**, not a microservices split. The cron worker, API, and event publisher all run inside one process (bullmq worker as a sibling entry point under the same package). Matches `feat-admission-plan`.
2. **Folder structure mirrors `feat-admission-plan`**: `src/{routes,services,middleware,lib,config,types}` + `prisma/` + `tests/{unit,service,integration}` + `docker-compose.yml`.
3. **TypeScript** for the BE (Node 20, ES modules) — deviation from `feat-admission-plan` (which is JS-with-JSDoc), per direction. Dev runs via `tsx --watch`; prod build via `tsc → dist/` and `node dist/index.js`. Zod `z.infer` for derived request/DTO types; Prisma's generated client types flow end-to-end. `tsconfig.json` set to `"module": "esnext"`, `"moduleResolution": "bundler"`, `"strict": true`.
4. **Demo auth via email + password** → signed JWT in an `HttpOnly Secure SameSite=None` cookie (8 h lifetime, no refresh). Login (`POST /auth/login { email, password }`) bcrypt-checks against `User.passwordHash` seeded by `prisma/seed.ts` (per-persona passwords, one per mock identity). Logout clears the cookie; `GET /auth/me` lets the FE rehydrate on reload. The passport SSO strategy is the production swap-in — the rest of the app keeps reading `req.user` only, so the cutover is one middleware change.
5. **EventPublisher**: a logger-backed implementation in dev; a queued (bullmq) outbound channel ready for ESB wiring later.
6. **Attachment storage adapter**: local disk in dev (`./uploads`); the `StorageAdapter` interface lets an object-storage adapter drop in later (§10 open item).
7. **Hosting target: Vercel** (serverless). Constrains a few of the defaults above:
   - `app.ts` is exported as a Vercel serverless function handler (catch-all route); no `app.listen()` in prod (it stays for local `tsx --watch`).
   - The bullmq **continuous worker becomes a Vercel Cron** invocation: `vercel.json` `crons:` schedules `POST /jobs/daily-reminder` (shared-secret guarded). The same handler in `jobs/daily-reminder.ts` is reused; local dev still runs the bullmq worker via `tsx`.
   - Managed **Postgres** (Vercel Postgres / Neon) + managed **Redis** (Upstash) — both serverless-safe (pooled connections; HTTPS for QStash if used).
   - **Attachment storage** in prod must be object storage (Vercel Blob / S3 / R2) — local disk only works locally; §K open item is now blocking for Step 5/6.
   - EventPublisher → either direct HTTPS push or Upstash **QStash**; the in-process bullmq queue is dev-only.

## B. Architecture overview

The service is a stateless Express API + a bullmq worker process, both reading/writing one Postgres DB and using Redis for the job queue. SSO identity comes in on every request; the service is the **lifecycle authority** for tickets.

```mermaid
flowchart TB
  subgraph Consumers["API consumers"]
    feUI["FE — feat-helpdesk-ticket"]
    portalSV["Cổng SV (M20)"]
    portalGV["Cổng GV (M21)"]
  end

  subgraph App["M31 API service (Express)"]
    routes["Routes"]
    mw["Middleware: requestId → auth → rbac → zod → error"]
    svcTicket["TicketService"]
    svcCat["CategoryService"]
    svcRoute["RoutingService"]
    svcAssign["AssignmentService"]
    svcNotify["NotificationService"]
    svcAttach["AttachmentService"]
    publisher["EventPublisher (queue)"]
  end

  subgraph Worker["Reminder worker (bullmq)"]
    reminder["Daily 09:00 cron"]
  end

  subgraph Infra["Infrastructure"]
    iam[("M1 IAM/SSO — mocked")]
    esb[("M2 ESB — stub")]
    lake[("M3 Data Lake — stub")]
    db[("Postgres")]
    redis[("Redis")]
    store[("Local disk / Object storage")]
  end
  ai[["M29 AI triage — deferred seam"]]

  feUI & portalSV & portalGV --> routes
  routes --> mw --> svcTicket
  svcTicket --> svcCat & svcRoute & svcAssign & svcNotify & svcAttach
  svcTicket --> db
  svcNotify --> db
  svcAttach --> store
  mw -. "verify identity/role" .-> iam
  svcTicket --> publisher --> esb --> lake
  reminder --- redis
  reminder --> db
  reminder --> svcNotify
  svcTicket -. "classify (later)" .-> ai
```

### Folder structure

```
feat-helpdesk-api/
  docs/                          # brief, this feature-plan, impl-plan, test-design
  prisma/
    schema.prisma
    migrations/0001_create_m31_helpdesk/
  src/
    index.ts                     # API entry (binds Express)
    worker.ts                    # bullmq worker entry (reminder + event publisher)
    app.ts                       # Express app factory (exported for tests via supertest)
    config/env.ts                # zod-validated env
    middleware/                  # requestId, auth (mock/passport), rbac, zodValidate, error, multer
    routes/                      # tickets, categories, routing-rules, notifications, analytics, healthz
    services/                    # TicketService, CategoryService, RoutingService, AssignmentService,
                                 # NotificationService, AttachmentService, AnalyticsService
    lib/                         # logger.ts (pino), prisma.ts, ids.ts (cuid), envelope.ts, errors.ts,
                                 # storage/local.ts + storage/index.ts (adapter), events/publisher.ts
    types/                       # domain.ts — TS types mirroring prior FP §4 enums/DTOs; many derived from Zod via z.infer
    jobs/                        # daily-reminder.ts (cron def + handler)
  tests/
    unit/                        # pure helpers (status mapper, severity, scoping, zod schemas)
    service/                     # service-layer (TicketService etc.) against a test Prisma DB
    integration/                 # full HTTP via supertest against app.ts + test DB + faked Redis
  docker-compose.yml             # postgres:15 + redis:7 (mirrors feat-admission-plan)
  package.json
  tsconfig.json
  vitest.config.ts
  .env / .env.example
  .github/workflows/ci.yml
```

## C. Ticket lifecycle (state machine + transitions)

```mermaid
stateDiagram-v2
  [*] --> Pending : create (SV/GV/NV)
  Pending --> Assigned : forward to dept (Helpdesk)
  Assigned --> InProgress : start progress (Staff/Helpdesk)
  Assigned --> Redirected : redirect (Helpdesk)
  InProgress --> Redirected : redirect (Helpdesk)
  Redirected --> Assigned : re-forward to new dept (Helpdesk)
  Pending --> Closed : close (Helpdesk)
  Assigned --> Closed : close (Helpdesk)
  InProgress --> Closed : close (Helpdesk)
  Closed --> [*]
  note right of Pending
    Lead assigns / reassigns Agent here
    (sets owner; no status change)
  end note
  note right of Closed
    Terminal — no reopen (v1)
  end note
```

**Transition table** (server enforces; each row = one Prisma transaction that updates `tickets` + inserts a `ticket_events` row + optionally a `notifications` row):

| Action | Pre-status | Post-status | Actor role | Side effects |
|---|---|---|---|---|
| `create` | – | `Pending` | SV/GV/NV | `TicketEvent[Created]`; `EventPublisher.ticketCreated`. |
| `assignAgent` | `Pending` | `Pending` *(attribute change only)* | `HelpdeskLead` | sets `helpdeskAssigneeId`; `TicketEvent[AgentAssigned]`; notify Agent (`TICKET_ASSIGNED`). |
| `forward` | `Pending` | `Assigned` | Helpdesk | sets `routedDepartmentId`; `TicketEvent[Forwarded]`; notify dept staff (`TICKET_FORWARDED`). |
| `startProgress` | `Assigned` | `InProgress` | `DeptStaff` (own dept) / Helpdesk | `TicketEvent[Started]`; notify requester (`STATUS_CHANGED`). |
| `redirect` | `Assigned` \| `InProgress` | `Redirected → Assigned` *(within same tx)* | Helpdesk | sets new `routedDepartmentId`; `TicketEvent[Redirected]` w/ from→to; notify new dept staff. |
| `overrideSeverity` | any non-Closed | unchanged | Helpdesk | updates `severity`; `TicketEvent[SeverityChanged]`. |
| `comment` | any non-Closed | unchanged | participants / Helpdesk | inserts `TicketComment` + `TicketEvent[Commented]`. |
| `close` | `Pending` \| `Assigned` \| `InProgress` | `Closed` | Helpdesk Lead **or** assigned Agent | sets `closedAt`; `TicketEvent[Closed]`; notify requester (`TICKET_CLOSED`); `EventPublisher.ticketClosed`. |

**Concurrency:** every transition reads the current status inside the transaction and rejects with **`409 conflict`** if it changed (optimistic guard). No reopen — `Closed` is terminal.

## D. Main-flow sequence (server perspective)

Legend: **FE** = FE / Portal · **H** = Helpdesk API · **DB** = Postgres · **Q** = bullmq (Redis) · **LK** = Data Lake (via ESB).

```mermaid
sequenceDiagram
  participant FE
  participant H
  participant DB
  participant Q
  participant LK

  FE->>H: POST /tickets (multipart + SSO)
  H->>DB: insert Ticket + Event(Created)
  H->>Q: enqueue EventPublished(ticketCreated)
  Q->>LK: publish (async)
  H-->>FE: 201 TicketDTO

  Note over FE,H: Lead assigns agent
  FE->>H: POST /tickets/:id/assign
  H->>DB: set helpdeskAssigneeId + Event(AgentAssigned) + Notification(TICKET_ASSIGNED)
  H-->>FE: 200 TicketDTO

  Note over FE,H: Helpdesk forwards
  FE->>H: POST /tickets/:id/forward
  H->>DB: status Pending to Assigned + Event(Forwarded) + Notification(TICKET_FORWARDED)
  H-->>FE: 200 TicketDTO

  Note over FE,H: Dept staff starts work
  FE->>H: POST /tickets/:id/progress
  H->>DB: status Assigned to InProgress + Event(Started) + Notification(STATUS_CHANGED)
  H-->>FE: 200 TicketDTO

  Note over FE,H: Helpdesk closes
  FE->>H: POST /tickets/:id/close
  H->>DB: status InProgress to Closed + Event(Closed) + Notification(TICKET_CLOSED)
  H->>Q: enqueue EventPublished(ticketClosed)
  Q->>LK: publish (async)
  H-->>FE: 200 TicketDTO
```

> Each `H->>DB:` write happens inside one Prisma transaction with the audit `TicketEvent` and the `Notification` row (per §C); the `BEGIN`/`COMMIT` pseudocode is dropped from the diagram because `;` is a statement separator in Mermaid's grammar.

## E. Data model (Prisma / Postgres)

**Conventions (match `feat-admission-plan`):** Prisma `provider = "postgresql"`; IDs `String @id @default(cuid())`; timestamps `createdAt @default(now())` + `updatedAt @updatedAt`; models PascalCase mapped via `@@map` to snake_case plural tables (`tickets`, `ticket_comments`, `attachments`, `categories`, `routing_rules`, `ticket_events`, `notifications`, `users`, `departments`). **Enum values use PascalCase** matching ISO labels (`Severity {Critical|High|Medium|Low}`, `TicketStatus {Pending|Assigned|InProgress|Redirected|Closed}`, `Role {SV|GV|NV|HelpdeskLead|HelpdeskAgent|DeptStaff|Admin}`, `NotificationType {TicketClosed|DailyReminder|TicketAssigned|TicketForwarded|StatusChanged}`, `EventType {Created|AgentAssigned|Forwarded|Started|Redirected|SeverityChanged|Commented|Closed}`).

```mermaid
erDiagram
  USER       ||--o{ TICKET        : "requester"
  USER       |o--o{ TICKET        : "assignee"
  CATEGORY   |o--o{ TICKET        : "classifies"
  DEPARTMENT |o--o{ TICKET        : "routed to"
  TICKET     ||--o{ TICKETCOMMENT : "has"
  TICKET     ||--o{ ATTACHMENT    : "has"
  TICKET     ||--o{ TICKETEVENT   : "audit"
  USER       ||--o{ NOTIFICATION  : "to"
  CATEGORY   |o--o{ CATEGORY      : "parent"
  CATEGORY   ||--o{ ROUTINGRULE   : "in"
  DEPARTMENT ||--o{ ROUTINGRULE   : "target"

  USER {
    string id PK
    string ssoSubject
    string email
    Role   role
    string departmentId FK
  }
  DEPARTMENT {
    string id PK
    string code
    string name
  }
  CATEGORY {
    string  id PK
    string  name
    string  parentId FK
    boolean isActive
  }
  ROUTINGRULE {
    string  id PK
    string  categoryId FK
    string  departmentId FK
    boolean isDefault
  }
  TICKET {
    string       id PK
    string       code
    Severity     severity
    TicketStatus status
    string       requesterId FK
    string       categoryId FK
    string       helpdeskAssigneeId FK
    string       routedDepartmentId FK
    datetime     createdAt
    datetime     closedAt
  }
  TICKETCOMMENT {
    string   id PK
    string   ticketId FK
    string   authorId FK
    datetime createdAt
  }
  ATTACHMENT {
    string         id PK
    string         ticketId FK
    string         commentId FK
    string         uploaderId FK
    AttachmentKind kind
    string         filename
  }
  TICKETEVENT {
    string       id PK
    string       ticketId FK
    string       actorId FK
    EventType    type
    TicketStatus fromStatus
    TicketStatus toStatus
  }
  NOTIFICATION {
    string           id PK
    string           userId FK
    NotificationType type
    string           ticketId FK
    datetime         readAt
  }
```

**Indexes:** `tickets(status)`, `tickets(helpdesk_assignee_id, status)`, `tickets(routed_department_id, status)`, `tickets(requester_id)`, `tickets(created_at)`, `categories(parent_id)`, `routing_rules(category_id)`, `notifications(user_id, read_at)`, `ticket_events(ticket_id, created_at)`.
**Migration:** `0001_create_m31_helpdesk` (+ `.down.sql`) — creates all M31 tables; seed script for `departments` + default `categories` + their `routing_rules`.

## F. API contract (REST, base `/api/v1`)

**Canonical contract:** `feat-helpdesk-ticket/docs/feature-plan.md` §5 (kept in sync — same endpoints, envelope, statuses, scoping rules). Reproduced here only to call out the **server-side** rules:

- **Envelope:** every response is `{ data, error: null, requestId }` (success) or `{ data: null, error: { code, message, fields? }, requestId }` (failure).
- **Errors:** `400` Zod validation; `401` no/invalid SSO; `403` RBAC/ownership; `404`; `409` illegal state-machine transition (stale current status); `413` attachment too large; `422` Zod schema or business validation; `5xx` reserved for genuine server errors.
- **Server-derived scoping (never trust a client param):** `SV/GV/NV` → only own `requesterId`; `DeptStaff` → only `routedDepartmentId = caller.departmentId`; `HelpdeskAgent` → only `helpdeskAssigneeId = caller.id` on personal queues, all tickets on shared queues; `HelpdeskLead` & `Admin` → all.
- **`status` query** on `GET /tickets`: accepts CSV or repeated values from `{Pending,Assigned,InProgress,Redirected,Closed}`, **or** the convenience value `open` meaning every non-`Closed` state.
- **Mutations** use Zod-validated request bodies; FormData on `POST /tickets` and `POST /:id/comments` (multer).

The full per-endpoint table — `POST /tickets`, `GET /tickets`, `GET /tickets/:id`, `POST /:id/{assign,forward,progress,close,comments}`, `PATCH /:id/{severity,category}`, `GET /:id/{history,comments}`, `GET /attachments/:id`, `GET/POST/PATCH/DELETE /categories[/:id]`, `GET/POST /notifications[/:id/read]`, `DELETE /notifications`, `GET /analytics/summary`, `GET /healthz` — lives in the canonical FP §5.

**Auth endpoints (demo build):**

| Method + path | Body | Returns | Notes |
|---|---|---|---|
| `POST /auth/login` | `{ username, password }` | 200 envelope `{ user }` + `Set-Cookie` JWT | 401 on bad credentials; rate-limited; opaque error message ("Sai tài khoản hoặc mật khẩu") so attackers can't enumerate. |
| `POST /auth/logout` | — | 200 empty envelope + `Set-Cookie` clearing | Idempotent; no 401 if cookie missing. |
| `GET /auth/me` | — | 200 envelope `{ user }` if cookie valid, 401 otherwise | The FE calls this on app boot to rehydrate `SessionProvider`. |

### Middleware order

`requestId → pino-http (log) → cors (credentials: true, origin from env) → helmet → cookie-parser → body parser (json | multipart for upload routes) → auth (verify JWT cookie, attach req.user{id,role,departmentId}) → rbac (route-level capability check) → zodValidate (per route) → handler → error (envelope-shapes everything)`.

### Identity contract

Demo mode: `auth` middleware reads the `m31_session` cookie, verifies the JWT against `JWT_SECRET`, hydrates `req.user` from the payload. `/auth/login` is the only endpoint that runs **before** this middleware (it issues the cookie); `/healthz` and `/docs/*` remain public. Production mode: passport SSO strategy resolves the SSO token to the same `req.user` shape — the rest of the app is unchanged.

## G. Notifications & the daily 09:00 reminder

- **In-app only, persisted as `Notification` rows.** Endpoints: `GET /notifications` (caller's own, unread-first, paginated); `POST /notifications/:id/read`.
- **Triggered by the lifecycle**: `TICKET_CLOSED` to requester (close handler), `TICKET_ASSIGNED` to agent (assign handler), `TICKET_FORWARDED` to dept staff (forward handler), optional `STATUS_CHANGED` to requester (progress handler). All inserted in the same transaction as the status change.
- **Daily reminder** — bullmq repeatable job, cron `0 9 * * 1-5`, TZ `Asia/Ho_Chi_Minh`, public-holiday skip via `lib/calendar.js` (config file of dates). For every Helpdesk agent with ≥1 backlog ticket (`status IN {Pending, Assigned, Redirected}`, `helpdeskAssigneeId = agent.id`), insert one `DAILY_REMINDER` notification with `payload = { tickets: [{id, code, severity, ageDays}] }`. **Idempotent** via dedupe key `reminder:{agentId}:{YYYY-MM-DD}` stored in Redis (24h TTL).
- **Runtime split**: local dev runs `worker.ts` as a long-running `tsx --watch` process consuming the bullmq queue. On **Vercel**, `vercel.json` `crons:` hits `POST /jobs/daily-reminder` (shared-secret-guarded) on the same `0 9 * * 1-5` schedule — the handler in `jobs/daily-reminder.ts` is the single source of truth and is invoked by both runtimes (long-running consumer locally, scheduled serverless function in prod).

## H. Dependencies (Node, ES modules)

- **Runtime:** `express`, `@prisma/client`, `prisma` (dev), `zod`, `passport` + `passport-google-oauth20` (production SSO strategy), `multer`, `bullmq` + `ioredis`, `helmet`, `express-rate-limit`, `pino`, `pino-http`, `pino-pretty` (dev), `cors`, `cuid`/`@paralleldrive/cuid2`, `date-fns` + `date-fns-tz` (TZ math for the holiday calendar).
- **Dev/test (TypeScript toolchain):** `typescript`, `tsx` (dev/watch entry), `@types/node`, `@types/express`, `@types/multer`, `@types/supertest`, `vitest`, `supertest`, `@vitest/coverage-v8`, `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-config-prettier`, `prettier`. Test DB: ephemeral Postgres via the same `docker-compose.yml`; a `tests/helpers/test-db.ts` truncates between tests.

## I. Non-functional requirements

- **Security:** auth required everywhere except `/healthz`, `/docs/*`, and `/auth/login` itself; RBAC enforced at route + service layer (defence in depth); helmet; per-route rate limits on `POST /auth/login`, `POST /tickets`, and `POST /:id/comments`; passwords stored as bcrypt hashes (cost ≥ 10); JWT signed with `JWT_SECRET` (≥ 32 random bytes, no fallback), `HttpOnly Secure SameSite=None` cookie scoped to the BE origin; attachments — MIME allowlist (images: jpg/png/webp/gif; docs: pdf/doc/docx/xls/xlsx), ≤10 MB, ≤5 files, stored outside webroot, streamed download with authz, virus-scan hook for later; Zod validation on every mutation; **no passwords, JWT secrets, or PII in logs**; SQL safety via Prisma parameterised queries.
- **Observability:** pino structured logs; `requestId` generated by the requestId middleware, propagated to logger child + response envelope; the `TicketEvent` audit table is the in-DB audit log; `GET /healthz` for liveness; analytics summary endpoint feeds the FE module dashboard.
- **Reliability:** status transition + audit row + notification row in **one Prisma transaction**; optimistic guard on current status → `409` on stale write; bullmq retries (max 3, exponential) for the reminder job + event publisher; idempotent reminder via dedupe key; graceful shutdown drains the queue.
- **Performance:** list endpoints paginated (default 20, max 100); the indexes above; attachment streaming (not buffered); the reminder job batches one DB query per agent group.
- **i18n:** error `message` fields in Vietnamese (the API is internal); `code` stable ASCII for clients to map.

## J. Risks & mitigations (technical)

| Risk | Mitigation |
|---|---|
| Concurrent Helpdesk actions race the state machine | Transaction + optimistic current-status check → `409`. |
| Attachment abuse (size/type/malware) | Size/type/count caps, storage quota, scan hook, authz on download. |
| Reminder missed or duplicated | bullmq repeatable + monitoring; idempotent dedupe key per agent/day. |
| Data-lake coupling slows ticket ops | Async event publish via queue; failures isolated. |
| Category delete with live tickets/children | Block delete or soft-delete + reassign guard. |
| IAM role staleness | Resolve role from SSO token each request; periodic user sync. |
| Long-running Prisma migrations during deploy | Migrations are additive on first ship (greenfield); future schema changes go through a separate review. |

## K. Open items for review (Tech Lead)

1. **Reminder backlog set:** v1 = `{Pending, Assigned, Redirected}` (excludes `InProgress`, following ISO §8 literally). Include `InProgress` so Helpdesk doesn't forget to chase stale department work?
2. **Attachment storage adapter for prod:** local-disk works in dev; pick the production adapter (object storage / Drive / on-prem NFS) at Step 5/6.
3. **Ticket `code` format:** default `HD-YYYY-NNNNNN`. Confirm format + monotonic sequence source (Postgres sequence vs Redis counter vs `cuid2` slug).
4. **Notification fanout for high-severity tickets:** ISO doesn't require it; future enhancement.
5. **Soft-delete vs hard-delete for category tree.**

## L. Rollback plan

- Prisma migration `0001_create_m31_helpdesk` has a matching `.down.sql` (drops M31 tables only — no shared tables touched). `prisma migrate resolve --rolled-back` + manual down for emergency.
- Feature flag **`HELPDESK_ENABLED`** to disable all routes (returns `503`) without a redeploy.
- The bullmq repeatable reminder job can be disabled by removing the repeatable + draining the queue.
- Deploy-by-tag rollback per the team release flow (process §6.5). Practice mode stops at Step 7 — no real rollback drill.

## M. Epic / Story decomposition (Jira stand-in)

**Epic:** `M31 (BE) — Helpdesk / Ticket service` (link: this Feature Plan).

| Story | Title | Core AC focus |
|---|---|---|
| BE-S1 | Project scaffold + envelope + healthz + auth/RBAC middleware | mock-SSO middleware sets `req.user`; rbac middleware rejects with `403`; envelope shape covers success + error; `GET /healthz` returns `200`. |
| BE-S2 | Prisma schema + migration + seed (depts, categories, routing) | `0001_create_m31_helpdesk` migration up/down clean; seed loads departments + default categories + their routing rules. |
| BE-S3 | Categories + routing-rules CRUD | Admin-only; delete guards (children, live tickets); 422 on duplicate name; routing default per category. |
| BE-S4 | Ticket create + list + detail (read paths) | server-derived scoping per role; status=open + multi-status filter; attachments upload via multer; envelope errors. |
| BE-S5 | State machine: assign / forward / redirect / progress / close + severity override | one Prisma transaction per transition; `409` on stale current-status; audit `TicketEvent` row inserted; correct role gating. |
| BE-S6 | Comments + comment attachments + history endpoint | participants/Helpdesk only; `TicketEvent[Commented]`; `GET /:id/history` ordered by `createdAt`. |
| BE-S7 | In-app notifications: store + list + mark-read + lifecycle inserts | TICKET_CLOSED / ASSIGNED / FORWARDED / STATUS_CHANGED inserted in the transition transaction; read-only of caller's own. |
| BE-S8 | Daily 09:00 reminder worker (bullmq) | cron `0 9 * * 1-5` TZ Asia/Ho_Chi_Minh; holiday-skip; idempotent dedupe; per-agent backlog query is one round-trip. |
| BE-S9 | EventPublisher (logger adapter) + ticket lifecycle events | non-blocking publish; retries on failure; logger adapter prints the event shape; interface ready for ESB adapter. |
| BE-S10 | Analytics summary endpoint | counts by severity/category/status, avg handling time; RBAC: Helpdesk/Admin/BGH only. |

---

*Traceability: ISO M31 → BE Brief → this Feature Plan → 10 Stories (BE-S1…BE-S10) → Tasks. Next per process: **Step 4** — `/sc:test --design --persona-qa` to turn each Story's AC into BE test cases (vitest unit + service + supertest integration) before any code.*
