import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed, type SeedCounts } from '../../prisma/seed';
import { disconnect, resetDb, testPrisma as prisma } from '../helpers/test-db';

interface TableRow {
  table_name: string;
}

const EXPECTED_TABLES = [
  'attachments',
  'categories',
  'departments',
  'notifications',
  'ticket_comments',
  'ticket_events',
  'tickets',
  'users',
];

async function counts(): Promise<SeedCounts> {
  return {
    departments: await prisma.department.count(),
    categories: await prisma.category.count(),
    users: await prisma.user.count(),
  };
}

describe('BE-S2 — Prisma schema + seed', () => {
  beforeAll(async () => {
    // Migrations are assumed to have been deployed (`npx prisma migrate deploy`).
    // Start from a clean state and seed once for deterministic counts.
    await resetDb();
    await runSeed(prisma);
  });

  afterAll(async () => {
    await disconnect();
  });

  it('M31-BE-S2-H1: all M31 tables exist in the public schema', async () => {
    const rows = await prisma.$queryRawUnsafe<TableRow[]>(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY ($1::text[])
      ORDER BY table_name
    `,
      EXPECTED_TABLES,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(EXPECTED_TABLES);
  });

  it('M31-BE-S2-E1: seed populated 5 departments and 6 flat categories', async () => {
    const c = await counts();
    expect(c.departments).toBe(5);
    expect(c.categories).toBe(6);
  });

  it('M31-BE-S2-E2: re-running the seed is idempotent (counts unchanged)', async () => {
    const before = await counts();
    await runSeed(prisma);
    const after = await counts();
    expect(after).toEqual(before);
  });
});
