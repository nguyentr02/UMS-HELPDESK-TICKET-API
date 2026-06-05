-- Down-script for 20260604000000_user_password_hash. Manual application only —
-- Prisma doesn't run this; kept for documentation + emergency rollback.

ALTER TABLE "users" DROP COLUMN "passwordHash";
