-- Down-script for 20260605000000_user_google_columns. Manual application only.

DROP INDEX IF EXISTS "users_googleId_key";
ALTER TABLE "users" DROP COLUMN IF EXISTS "avatarUrl";
ALTER TABLE "users" DROP COLUMN IF EXISTS "googleId";
