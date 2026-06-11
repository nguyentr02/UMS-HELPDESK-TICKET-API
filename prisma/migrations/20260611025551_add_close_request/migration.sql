-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'CloseRequested';
ALTER TYPE "EventType" ADD VALUE 'CloseRefused';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'CloseRequested';
ALTER TYPE "NotificationType" ADD VALUE 'CloseRefused';

-- AlterEnum
ALTER TYPE "TicketStatus" ADD VALUE 'CloseRequested';

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "closeRequestedById" TEXT;
