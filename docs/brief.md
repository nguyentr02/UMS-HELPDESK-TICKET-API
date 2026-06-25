# Brief — M31 Helpdesk / Ticket (Back-end)

| Field | Value |
|---|---|
| Module | **M31 — Helpdesk / Ticket** — **Back-end** |
| Nhóm | I — Hạ tầng & Trí tuệ |
| Workspace | `feat-helpdesk-api/` *(new — sibling to `feat-helpdesk-ticket/` which delivers the FE)* |
| Source ISO | `DAU-ISO/ISO_M31_Helpdesk_Ticket_v1.0.docx` — v1.1 (Draft, 27/05/2026) |
| Roadmap | Phase 1 (2026); CAIRA chủ trì kỹ thuật |
| Prior product Brief | `feat-helpdesk-ticket/docs/brief.md` *(canonical product framing — kept in sync)* |
| Prior Feature Plan refs | `feat-helpdesk-ticket/docs/feature-plan.md` §5 (API contract), §4 (data model) |
| Brief status | Draft — open questions resolved with PM/BA |
| Author | CAIRA-DAU Dev (brainstorm output, Step 2) |
| Language | English narrative; Vietnamese domain terms verbatim |
| Tier | Tier 2 (Brief) → next: BE Feature Plan |
| Stack (decided) | Node 22 · Express 4 · Prisma 5 (Postgres) · Zod · `google-auth-library` (Google OAuth) · multer + Vercel Blob (attachments) · bullmq (cron) · pino · vitest |

> This Brief distils ISO M31 from the **back-end** perspective. The product is unchanged from the prior FE round, so the 8 resolved product decisions are inherited (§7). This round scopes the **service that owns data, business logic, jobs, and integrations** behind the M31 API; the FE at `feat-helpdesk-ticket/` is the primary consumer.

---

## 1. Problem statement

When a student (SV), lecturer (GV), or staff member (NV) hits a problem — digital (UMS, LMS, email, Wi-Fi) or physical on campus (điện, nước, điều hoà, thiết bị phòng học) — UMS has **no unified intake channel** today. Requests scatter across personal email, Zalo, and face-to-face. Four concrete failures follow: duplicate/dropped handling, no traceability, no status visibility for requesters, and no school-wide operational view for BGH.

The **back-end** introduces the system of record + control plane that makes the unified Helpdesk possible: persistent state, role-aware API, audited lifecycle, scheduled jobs, and analytics-event emission. Without the BE, the FE has nothing real to talk to.

## 2. Objectives (back-end)

1. **System of record** for every support request — durable, queryable storage of tickets, comments, attachments, plus a full **audit trail** (`TicketEvent`) inside every transition transaction.
2. **Lifecycle authority** server-side — the §2 state machine (statuses `Pending → Assigned → InProgress → Closed`, plus the `CloseRequested` / `RedirectRequested` request states; redirect is an action that returns a ticket to `Assigned` under a new department and records a `Redirected` *event* — not a status) is enforced by the BE; illegal transitions return `409`. The FE/portals never hold the truth.
3. **One API the FE & portals consume** — the contract in prior FP §5 (envelope `{data,error,requestId}`, **server-derived role scoping**, no client-supplied `departmentId`).
4. **No dropped tickets** — `0 9 * * 1-5` (Asia/Ho_Chi_Minh, holiday-skip) bullmq job emits one in-app `DAILY_REMINDER` per Helpdesk agent with their non-Closed backlog; idempotent per agent/day.
5. **Operational insight** for BGH — ticket lifecycle events emitted to **M3 data lake** via **M2 ESB**, abstracted behind an `EventPublisher` interface (async, non-blocking, failures isolated from ticket ops).

## 3. Roles enforced server-side

All requests authenticated via the **demo login** or **Google OAuth** (see §5): **email + password** *or* Google sign-in → JWT in an `HttpOnly Secure SameSite=None` cookie (8 h). Identity is decoded from the JWT, but on every authenticated request `requireAuth` **re-validates the session against the DB**: a deactivated/deleted user is rejected immediately (not after the token expires), and role/department are refreshed from the DB source of truth — **never from a client param**. The BE contract (role-scoped reads, no client-supplied `departmentId`) doesn't change.

| Role | What the BE enforces |
|---|---|
| **SV / GV / NV** | Create tickets, comment on own; reads scoped to `requesterId = caller.id`. |
| **Helpdesk Lead** | Assign agent (only Lead); forward / redirect / close any; override severity. |
| **Helpdesk Agent** | Handle assigned tickets; forward / redirect / close; the 09:00 reminder targets `helpdeskAssigneeId = caller.id`. |
| **DeptStaff** | Reads scoped to `routedDepartmentId = caller.departmentId`; mark In Progress; comment. Cannot close. |
| **Admin** | Category CRUD (runtime); reads all. (Department routing is a manual Agent/Lead pick per ticket — no rule engine.) |
| **BGH** (read) | `GET /analytics/summary` (counts by severity/category/status, avg handling time). |

## 4. Success criteria

(Same product targets — measured server-side from BE data.)
- **Adoption:** 100% of in-school support requests recorded in the API within **4 weeks** of go-live.
- **Routing quality:** first-time-correct routing **≥ 85%** after month 1 (default routing from category × Helpdesk redirect feedback).
- **Zero lost tickets** (no status / no owner) once the system is stable.
- **Backlog control:** share of tickets with `age-since-creation > 3 days` **< 10%** after month 1 — driven by the daily reminder.

## 5. Scope

### In scope (BE)
- **REST API** per prior FP §5: tickets, comments, attachments, categories, notifications, analytics summary, health, **plus the demo auth endpoints (`POST /auth/login`, `POST /auth/logout`, `GET /auth/me`)**.
- **Demo authentication** — **email + bcrypt-hashed password** against the seeded mock identities (`sv01@ums.edu.vn`, `admin@ums.edu.vn`, etc.); successful login issues a signed JWT in an `HttpOnly Secure SameSite=None` cookie (8 h lifetime, no refresh). Logout clears the cookie. `GET /auth/me` lets the FE rehydrate the session on reload. No registration, no password reset — re-seed if a password ever needs to rotate.
- **Persistent data model** per prior FP §4 (Postgres via Prisma; PascalCase enums; `@@map` snake_case tables; cuid IDs; standard timestamps).
- **State-machine enforcement** server-side; transition + audit row in one Prisma transaction; optimistic guard on current status → `409`.
- **RBAC** + **server-derived scoping** — every read filters by the caller's role/identity; `departmentId` from the client is ignored.
- **Attachment service** — two intake paths: multer multipart (function-body) and the primary **Vercel Blob direct-upload broker** (`POST /attachments/upload-url`, auth-gated) where the browser uploads straight to Blob, bypassing the function-body limit. Both enforce a MIME allowlist (images: jpg/png/webp/gif; docs: pdf/doc/docx/xls/xlsx) with **magic-byte content sniffing** (defeats a spoofed Content-Type), ≤ **10 MB**/file, ≤ **5** files. A **virus-scan hook** (`setVirusScanner`, no-op by default) runs on the multer path; **Blob-path validation** (`validateBlobAttachment`) range-fetches the header to sniff content + verify the true size for files the BE never buffered. An **orphan-Blob GC sweep** (`jobs/blob-sweep.ts`, its own daily cron) deletes blobs uploaded but never referenced. Authz-checked stream download; images/PDFs served `inline` for preview, everything else as `attachment`.
- **Cron** — bullmq repeatable `0 9 * * 1-5` (Asia/Ho_Chi_Minh, public-holiday skip); per-agent backlog = owned tickets in `{Pending, Assigned}`; idempotent dedupe key `reminder:{agentId}:{yyyy-mm-dd}`.
- **In-app notification store** (`Notification` rows) + endpoints `GET /notifications`, `POST /:id/read`.
- **Outbound event emission** — `EventPublisher` interface; ticket lifecycle events queued and published to ESB/data lake; non-blocking.
- **Admin** endpoints: category management (delete-guard for live tickets). Department routing is a manual Agent/Lead pick per ticket — there is no configurable routing-rule entity.
- **Google OAuth login** (Authorization Code Flow, BE-mediated; signed-state CSRF; `@ums.edu.vn`/`@dau.edu.vn` allowlist; deactivated accounts blocked). *(BE-S12, added 2026-06)*
- **Admin user management** *(scope exceptions, 2026-06)* — `GET /users[/:id]` directory (read-only), `POST /users` create, `PATCH /users/:id` update (email immutable), `DELETE /users/:id` soft delete. Institutional-email + name-format validation; deactivated users hidden from the list and blocked from SSO; re-creating a deactivated email revives the row. User lifecycle normally lives in M1/IAM — these were built for the practice/demo per explicit decision.
- **Observability** — pino structured logs + `requestId` correlation; health endpoint; module Lớp-1 analytics summary.

### Out of scope
- **Front-end / UI** — delivered separately by `feat-helpdesk-ticket/` (Next.js + Tailwind) and the Cổng SV/GV (M20/M21) portal embeds.
- **AI triage (M29)** — deferred; a clean `TriageProvider` integration seam exists but no-ops in v1.
- **Real M1 SSO** — for the demo, replaced by email/password login + **Google OAuth** (both issue the JWT cookie; Google is shipped via `google-auth-library`, see §5). The `X-Mock-*` header shim is kept as a **non-production** fallback so the existing test suite keeps working; production runs JWT-only. The contract on `req.user` doesn't change.
- **Registration, password reset, "remember me", session refresh** — out of scope for the demo. The credential helper on the FE login page is the "reset" (it shows each persona's password); re-seed to rotate.
- **Real M2 ESB / M3 data lake** — `EventPublisher` ships a logging implementation in dev; the wire integration is later.
- **Email / Zalo / push** notifications — in-app only in v1.
- **Ticket reopen** after close — terminal.
- **Auto-assignment within a department** — Lead-only at the Helpdesk layer.
- **Hard per-category SLA** — future.

## 6. Notable refinement vs. ISO (carried)

The ISO defines a single **Helpdesk** role. The BE splits it into **Helpdesk Lead** (dispatch — assigns agents, may redirect/close) + **Helpdesk Agent** (handler — receives assigned tickets, may close). The split makes the 09:00 reminder's per-agent backlog well-defined and is what the RBAC layer enforces.

## 7. Resolved product decisions (carried from prior Brief §0)

1. **AI triage (M29) deferred** — seam only; no AI in v1.
2. **In-app notifications only** — close-notification + 09:00 reminder; no email/Zalo/push.
3. **Helpdesk ownership = Lead assigns** (split Lead vs Agent).
4. **Attachments = images + documents** on ticket creation and comments.
5. **Backlog age = days since ticket creation** (reminder + the <3-day metric).
6. **No reopen in v1** — `Closed` is terminal.
7. **Close authority = Lead or assigned Agent** (Staff/requesters never close).
8. **Reminder cadence = Mon–Fri 09:00 Asia/Ho_Chi_Minh**, skipping public holidays.

## 8. Risks & assumptions

### Assumptions
- All phòng ban onboarded; their Staff users exist in SSO with correct roles.
- A Helpdesk unit exists (Lead + Agents) trained on the system.
- **Postgres + Redis** are available (matches the `feat-admission-plan/docker-compose.yml`).
- **Admin** is trained to manage categories at runtime.
- **M1 SSO / M2 ESB / M3 data lake** will land later; for the practice run they are **mocked or stubbed behind interfaces**.

### Risks → mitigations
- **Concurrent Helpdesk actions race the state machine.** → Transaction + optimistic current-status check → `409` + UI "refresh".
- **Attachment abuse (size/type/malware).** → Size/type/count caps; storage quota; virus-scan hook for later; authz on download.
- **Reminder missed / duplicated.** → bullmq repeatable + idempotent dedupe key per agent/day; monitoring on the queue.
- **Data-lake coupling slows ticket ops.** → Async event publish; failures isolated; never block the API.
- **Category delete with live tickets.** → Block or soft-delete with reassign guard (categories are a flat list — no child categories).
- **IAM role staleness.** → Resolve role from SSO token on each request; periodic user sync.

## 9. Open questions

**None blocking the Brief.** The 4 minor items raised in the FE round (backlog-age definition, reopen, close authority, working-day calendar) are already resolved in §7. Three **tech-level** items are appropriate for the **BE Feature Plan §11 review**, not the Brief:

1. Reminder backlog set — include `InProgress` or follow ISO §8 strictly (currently: exclude).
2. Attachment storage backend for production (local-disk adapter vs object-storage adapter).
3. Ticket `code` format (default `HD-YYYY-NNNNNN`).

---

*Traceability: ISO M31 v1.1 → this BE Brief → next: **BE Feature Plan** (`feat-helpdesk-api/docs/feature-plan.md`) → Epic/Stories → Tasks. Practice mode: stop at Step 7 (Test); no commit/PR/deploy.*
