-- Reverse 20260601000000_create_m31_helpdesk
-- Drops only M31 tables/types; never touches shared schema objects.

DROP TABLE IF EXISTS "notifications"   CASCADE;
DROP TABLE IF EXISTS "ticket_events"   CASCADE;
DROP TABLE IF EXISTS "attachments"     CASCADE;
DROP TABLE IF EXISTS "ticket_comments" CASCADE;
DROP TABLE IF EXISTS "tickets"         CASCADE;
DROP TABLE IF EXISTS "routing_rules"   CASCADE;
DROP TABLE IF EXISTS "categories"      CASCADE;
DROP TABLE IF EXISTS "users"           CASCADE;
DROP TABLE IF EXISTS "departments"     CASCADE;

DROP TYPE IF EXISTS "AttachmentKind";
DROP TYPE IF EXISTS "EventType";
DROP TYPE IF EXISTS "NotificationType";
DROP TYPE IF EXISTS "Role";
DROP TYPE IF EXISTS "TicketStatus";
DROP TYPE IF EXISTS "Severity";
