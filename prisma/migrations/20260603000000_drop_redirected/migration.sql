-- Remove the vestigial `Redirected` value from TicketStatus and EventType.
-- PostgreSQL has no `ALTER TYPE ... DROP VALUE`, so we type-swap: rename old,
-- create new, rewrite the column type, drop old. Any in-flight `Redirected`
-- tickets collapse to `Pending` (safe rollback to the start of the lifecycle);
-- `Redirected` audit events are deleted since the feature itself is gone.

BEGIN;

-- 1. TicketStatus
ALTER TYPE "TicketStatus" RENAME TO "TicketStatus_old";

CREATE TYPE "TicketStatus" AS ENUM ('Pending', 'Assigned', 'InProgress', 'Closed');

UPDATE "tickets" SET "status" = 'Pending' WHERE "status"::text = 'Redirected';

ALTER TABLE "tickets"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "TicketStatus" USING "status"::text::"TicketStatus",
  ALTER COLUMN "status" SET DEFAULT 'Pending';

ALTER TABLE "ticket_events"
  ALTER COLUMN "fromStatus" TYPE "TicketStatus" USING "fromStatus"::text::"TicketStatus",
  ALTER COLUMN "toStatus" TYPE "TicketStatus" USING "toStatus"::text::"TicketStatus";

DROP TYPE "TicketStatus_old";

-- 2. EventType — delete any historical `Redirected` events before the swap.
DELETE FROM "ticket_events" WHERE "type"::text = 'Redirected';

ALTER TYPE "EventType" RENAME TO "EventType_old";

CREATE TYPE "EventType" AS ENUM (
  'Created',
  'AgentAssigned',
  'Forwarded',
  'Started',
  'SeverityChanged',
  'Commented',
  'Closed'
);

ALTER TABLE "ticket_events"
  ALTER COLUMN "type" TYPE "EventType" USING "type"::text::"EventType";

DROP TYPE "EventType_old";

COMMIT;
