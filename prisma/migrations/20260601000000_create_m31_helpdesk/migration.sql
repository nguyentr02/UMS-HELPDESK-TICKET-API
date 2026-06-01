-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('Critical', 'High', 'Medium', 'Low');
CREATE TYPE "TicketStatus" AS ENUM ('Pending', 'Assigned', 'InProgress', 'Redirected', 'Closed');
CREATE TYPE "Role" AS ENUM ('SV', 'GV', 'NV', 'HelpdeskLead', 'HelpdeskAgent', 'DeptStaff', 'Admin');
CREATE TYPE "NotificationType" AS ENUM ('TicketClosed', 'DailyReminder', 'TicketAssigned', 'TicketForwarded', 'StatusChanged');
CREATE TYPE "EventType" AS ENUM ('Created', 'AgentAssigned', 'Forwarded', 'Started', 'Redirected', 'SeverityChanged', 'Commented', 'Closed');
CREATE TYPE "AttachmentKind" AS ENUM ('Image', 'Document');

-- departments
CREATE TABLE "departments" (
  "id"        TEXT NOT NULL,
  "code"      TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- categories (self-referencing)
CREATE TABLE "categories" (
  "id"        TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "parentId"  TEXT,
  "isActive"  BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "categories_name_parentId_key" ON "categories"("name", "parentId");
CREATE INDEX "categories_parentId_idx" ON "categories"("parentId");
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- users
CREATE TABLE "users" (
  "id"           TEXT NOT NULL,
  "ssoSubject"   TEXT NOT NULL,
  "email"        TEXT NOT NULL,
  "displayName"  TEXT NOT NULL,
  "role"         "Role" NOT NULL,
  "departmentId" TEXT,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_ssoSubject_key" ON "users"("ssoSubject");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
ALTER TABLE "users" ADD CONSTRAINT "users_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- routing_rules
CREATE TABLE "routing_rules" (
  "id"           TEXT NOT NULL,
  "categoryId"   TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "isDefault"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "routing_rules_categoryId_departmentId_key" ON "routing_rules"("categoryId", "departmentId");
CREATE INDEX "routing_rules_categoryId_idx" ON "routing_rules"("categoryId");
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- tickets
CREATE TABLE "tickets" (
  "id"                  TEXT NOT NULL,
  "code"                TEXT NOT NULL,
  "title"               TEXT NOT NULL,
  "description"         TEXT NOT NULL,
  "severity"            "Severity" NOT NULL,
  "status"              "TicketStatus" NOT NULL DEFAULT 'Pending',
  "requesterId"         TEXT NOT NULL,
  "categoryId"          TEXT,
  "helpdeskAssigneeId"  TEXT,
  "routedDepartmentId"  TEXT,
  "closedAt"            TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tickets_code_key" ON "tickets"("code");
CREATE INDEX "tickets_status_idx" ON "tickets"("status");
CREATE INDEX "tickets_helpdeskAssigneeId_status_idx" ON "tickets"("helpdeskAssigneeId", "status");
CREATE INDEX "tickets_routedDepartmentId_status_idx" ON "tickets"("routedDepartmentId", "status");
CREATE INDEX "tickets_requesterId_idx" ON "tickets"("requesterId");
CREATE INDEX "tickets_createdAt_idx" ON "tickets"("createdAt");
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requesterId_fkey"
  FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_helpdeskAssigneeId_fkey"
  FOREIGN KEY ("helpdeskAssigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_routedDepartmentId_fkey"
  FOREIGN KEY ("routedDepartmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ticket_comments
CREATE TABLE "ticket_comments" (
  "id"        TEXT NOT NULL,
  "ticketId"  TEXT NOT NULL,
  "authorId"  TEXT NOT NULL,
  "body"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ticket_comments_ticketId_createdAt_idx" ON "ticket_comments"("ticketId", "createdAt");
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- attachments
CREATE TABLE "attachments" (
  "id"         TEXT NOT NULL,
  "ticketId"   TEXT NOT NULL,
  "commentId"  TEXT,
  "uploaderId" TEXT NOT NULL,
  "filename"   TEXT NOT NULL,
  "mimeType"   TEXT NOT NULL,
  "kind"       "AttachmentKind" NOT NULL,
  "sizeBytes"  INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "attachments_ticketId_idx" ON "attachments"("ticketId");
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_commentId_fkey"
  FOREIGN KEY ("commentId") REFERENCES "ticket_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaderId_fkey"
  FOREIGN KEY ("uploaderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ticket_events
CREATE TABLE "ticket_events" (
  "id"               TEXT NOT NULL,
  "ticketId"         TEXT NOT NULL,
  "actorId"          TEXT NOT NULL,
  "type"             "EventType" NOT NULL,
  "fromStatus"       "TicketStatus",
  "toStatus"         "TicketStatus",
  "fromDepartmentId" TEXT,
  "toDepartmentId"   TEXT,
  "note"             TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ticket_events_ticketId_createdAt_idx" ON "ticket_events"("ticketId", "createdAt");
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- notifications
CREATE TABLE "notifications" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "type"      "NotificationType" NOT NULL,
  "ticketId"  TEXT,
  "payload"   JSONB NOT NULL,
  "readAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
