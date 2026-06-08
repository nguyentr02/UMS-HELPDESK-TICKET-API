-- M31 Helpdesk: Google OAuth — add googleId + avatarUrl to users (Phase 12).
-- Both nullable so existing rows stay valid; Google login populates them on
-- first sign-in (or when an existing email is linked to a Google account).

ALTER TABLE "users" ADD COLUMN "googleId" TEXT;
ALTER TABLE "users" ADD COLUMN "avatarUrl" TEXT;
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");
