# M31 Helpdesk / Ticket — Back-end

Node 20 · **TypeScript** · Express 4 · Prisma 5 (Postgres) · Zod · bullmq · pino · vitest + supertest.
Hosting target: **Vercel** serverless. Local dev via `tsx --watch`.

## Design docs

- [`docs/brief.md`](docs/brief.md) — Brief
- [`docs/feature-plan.md`](docs/feature-plan.md) — Feature Plan (architecture, state machine, API, data model)
- [`docs/test-design.md`](docs/test-design.md) — Test design (vitest unit / service / supertest integration)
- [`docs/impl-plans/feat-M31-helpdesk-be.md`](docs/impl-plans/feat-M31-helpdesk-be.md) — Implementation plan (12 phases)

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Express via `tsx watch src/index.ts` |
| `npm run worker` | bullmq worker via `tsx watch src/worker.ts` (local-only; on Vercel it's a cron-invoked endpoint) |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `npm test` / `coverage` | Vitest run / with coverage |
| `npm run prisma:migrate` / `prisma:reset` | Prisma local migration helpers |

## Status

**Phase 0 — scaffold & tooling.** Foundation, schema, routes, services, and the cron worker arrive in later phases per the implementation plan.
