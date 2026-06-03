import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export class AnalyticsFailedError extends AppError {
  constructor() {
    super(500, 'analytics_failed', 'Lỗi tổng hợp dữ liệu phân tích');
  }
}

type Severity = 'Critical' | 'High' | 'Medium' | 'Low';
type TicketStatus = 'Pending' | 'Assigned' | 'InProgress' | 'Closed';

export interface DepartmentBucket {
  departmentId: string;
  name: string;
  count: number;
}

export interface CategoryBucket {
  categoryId: string;
  name: string;
  count: number;
}

export interface AnalyticsSummary {
  total: number;
  open: number;
  closed: number;
  /** Average days from createdAt → closedAt across closed tickets. `null` when no closed rows. */
  avgHandlingDays: number | null;
  /** Dict keyed by Severity so the FE can do `bySeverity[s]` direct lookups. */
  bySeverity: Record<Severity, number>;
  byStatus: Record<TicketStatus, number>;
  byDepartment: DepartmentBucket[];
  byCategory: CategoryBucket[];
}

const ZERO_SEVERITY: Record<Severity, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
const ZERO_STATUS: Record<TicketStatus, number> = {
  Pending: 0,
  Assigned: 0,
  InProgress: 0,
  Closed: 0,
};

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

      // Resolve dept + category names so the FE doesn't need a second hop.
      const deptIds = byDept
        .map((b) => b.routedDepartmentId)
        .filter((id): id is string => id !== null);
      const catIds = byCategory
        .map((b) => b.categoryId)
        .filter((id): id is string => id !== null);
      const [deptRows, catRows] = await Promise.all([
        deptIds.length
          ? prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } })
          : Promise.resolve([] as Array<{ id: string; name: string }>),
        catIds.length
          ? prisma.category.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } })
          : Promise.resolve([] as Array<{ id: string; name: string }>),
      ]);
      const deptName = new Map(deptRows.map((d) => [d.id, d.name]));
      const catName = new Map(catRows.map((c) => [c.id, c.name]));

      // Convert the groupBy arrays into dicts so FE can do `byStatus[s]` lookups.
      const sevMap: Record<Severity, number> = { ...ZERO_SEVERITY };
      for (const b of bySeverity) sevMap[b.severity] = b._count._all;
      const statusMap: Record<TicketStatus, number> = { ...ZERO_STATUS };
      for (const b of byStatus) statusMap[b.status] = b._count._all;

      return {
        total,
        open: total - closed,
        closed,
        avgHandlingDays: avgRows[0]?.avg ?? null,
        bySeverity: sevMap,
        byStatus: statusMap,
        byDepartment: byDept
          .filter((b) => b.routedDepartmentId !== null)
          .map((b) => ({
            departmentId: b.routedDepartmentId as string,
            name: deptName.get(b.routedDepartmentId as string) ?? '',
            count: b._count._all,
          })),
        byCategory: byCategory
          .filter((b) => b.categoryId !== null)
          .map((b) => ({
            categoryId: b.categoryId as string,
            name: catName.get(b.categoryId as string) ?? '',
            count: b._count._all,
          })),
      };
    } catch (err) {
      // Don't leak the raw Prisma error to the client — log it and surface a
      // stable 500 envelope with `error.code='analytics_failed'`.
      logger.error({ err }, 'AnalyticsService.summary failed');
      throw new AnalyticsFailedError();
    }
  },
};
