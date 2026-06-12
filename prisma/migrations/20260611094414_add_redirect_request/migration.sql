-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'RedirectRequested';
ALTER TYPE "EventType" ADD VALUE 'RedirectRefused';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'RedirectRequested';
ALTER TYPE "NotificationType" ADD VALUE 'RedirectRefused';

-- AlterEnum
ALTER TYPE "TicketStatus" ADD VALUE 'RedirectRequested';

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "redirectRequestedById" TEXT;
