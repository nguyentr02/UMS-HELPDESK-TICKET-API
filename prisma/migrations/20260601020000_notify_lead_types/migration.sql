-- Lead-fanout notification types (HelpdeskLead is notified on every new ticket
-- and every comment added to a ticket).
ALTER TYPE "NotificationType" ADD VALUE 'TicketCreated';
ALTER TYPE "NotificationType" ADD VALUE 'TicketCommented';
