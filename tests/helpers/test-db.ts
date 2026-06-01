import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

// Single test-suite-wide client. Connection is opened lazily on first query.
export const testPrisma = new PrismaClient({ log: ['warn', 'error'] });

/** Truncate every M31 table — caller is responsible for re-seeding if needed. */
export async function resetDb(): Promise<void> {
  await testPrisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "notifications",
      "ticket_events",
      "attachments",
      "ticket_comments",
      "tickets",
      "routing_rules",
      "categories",
      "users",
      "departments"
    RESTART IDENTITY CASCADE
  `);
}

export async function disconnect(): Promise<void> {
  await testPrisma.$disconnect();
}
