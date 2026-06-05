-- M31 Helpdesk: demo auth — add bcrypt password hash to users
-- Nullable on purpose: existing rows stay valid, and any future user without a
-- hash simply cannot log in. The seed populates this column for the 13 demo
-- personas. No data migration in SQL (bcrypt happens in `prisma/seed.ts`).

ALTER TABLE "users" ADD COLUMN "passwordHash" TEXT;
