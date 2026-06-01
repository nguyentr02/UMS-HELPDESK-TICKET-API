-- Global sequence backing nextTicketCode(); year is part of the display only,
-- not a counter reset (single monotonic sequence across years).
CREATE SEQUENCE "ticket_code_seq" START 1 INCREMENT 1;
