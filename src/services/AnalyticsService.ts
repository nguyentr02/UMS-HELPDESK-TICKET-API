import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export class AnalyticsFailedError extends AppError {
  constructor() {
    super(500, 'analytics_failed', 'Lỗi tổng hợp dữ liệu phân tích');
  }
}

export interface CountBucket {
  key: string;
  count: number;
}

export interface AnalyticsSummary {
  total: number;
  open: number;
  closed: number;
  /** Average days from createdAt → closedAt across closed tickets. `null` when no closed rows. */
  avgHandlingDays: number | null;
  bySeverity: CountBucket[];
  byStatus: CountBucket[];
  byDepartment: CountBucket[];
  byCategory: CountBucket[];
}

interface AvgRow {
  avg: number | null;
}

export const AnalyticsService = {
  async summary(): Promise<AnalyticsSummary> {
    try {
      const [total, closed, bySeverity, byStatus, byDept, byCategory, avgRows] =
        await Promise.all([
          prisma.ticket.count(),
          prisma.ticket.count({ where: { status: 'Closed' } }),
          prisma.ticket.groupBy({ by: ['severity'], _count: { _all: true } }),
          prisma.ticket.groupBy({ by: ['status'], _count: { _all: true } }),
          prisma.ticket.groupBy({
            by: ['routedDepartmentId'],
            _count: { _all: true },
            where: { routedDepartmentId: { not: null } },
          }),
          prisma.ticket.groupBy({
            by: ['categoryId'],
            _count: { _all: true },
            where: { categoryId: { not: null } },
          }),
          // ::float8 makes Postgres return a JS number; pure AVG would arrive as a string.
          prisma.$queryRaw<AvgRow[]>`
            SELECT AVG(EXTRACT(EPOCH FROM ("closedAt" - "createdAt")) / 86400.0)::float8 AS avg
            FROM "tickets"
            WHERE "status" = 'Closed' AND "closedAt" IS NOT NULL
          `,
        ]);

      return {
        total,
        open: total - closed,
        closed,
        avgHandlingDays: avgRows[0]?.avg ?? null,
        bySeverity: bySeverity.map((b) => ({ key: String(b.severity), count: b._count._all })),
        byStatus: byStatus.map((b) => ({ key: String(b.status), count: b._count._all })),
        byDepartment: byDept
          .filter((b) => b.routedDepartmentId !== null)
          .map((b) => ({ key: b.routedDepartmentId as string, count: b._count._all })),
        byCategory: byCategory
          .filter((b) => b.categoryId !== null)
          .map((b) => ({ key: b.categoryId as string, count: b._count._all })),
      };
    } catch (err) {
      // Don't leak the raw Prisma error to the client — log it and surface a
      // stable 500 envelope with `error.code='analytics_failed'`.
      logger.error({ err }, 'AnalyticsService.summary failed');
      throw new AnalyticsFailedError();
    }
  },
};
