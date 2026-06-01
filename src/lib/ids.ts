import type { Prisma, PrismaClient } from '@prisma/client';

type AnyPrisma = PrismaClient | Prisma.TransactionClient;

/**
 * Format: HD-{YYYY}-{NNNNNN}. NNNNNN comes from a single Postgres sequence
 * `ticket_code_seq` and never resets between years — the year prefix is for
 * human readability only.
 */
export async function nextTicketCode(client: AnyPrisma, now: Date = new Date()): Promise<string> {
  const rows = await client.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('ticket_code_seq') AS n`;
  const n = Number(rows[0]?.n ?? 0);
  const year = now.getFullYear();
  return `HD-${year}-${String(n).padStart(6, '0')}`;
}
