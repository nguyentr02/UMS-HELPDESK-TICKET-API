import { prisma } from '../lib/prisma.js';
import { formatDateKey, isHolidaySkip } from '../lib/calendar.js';
import { defaultDedupe, type ReminderDedupe } from '../lib/dedupe.js';

const BACKLOG_STATUSES = ['Pending', 'Assigned', 'Redirected'] as const;
const MS_PER_DAY = 86_400_000;

export interface RunOptions {
  /** Injected clock — pass a fixed Date in tests for deterministic `ageDays`. */
  now?: Date;
  /** Dedupe adapter — pass a fresh MemoryDedupe in tests. */
  dedupe?: ReminderDedupe;
  /** Extra one-off holidays in `MM-DD` form (year-agnostic). */
  extraHolidays?: ReadonlySet<string>;
}

export interface RunResult {
  skipped: 'holiday' | null;
  agentsScanned: number;
  notificationsInserted: number;
}

/**
 * Single source of truth shared by the local bullmq worker and the Vercel-Cron
 * HTTP handler. For each active HelpdeskAgent, look up backlog tickets
 * (`Pending | Assigned | Redirected`); if non-empty, dedupe on
 * `reminder:{agentId}:{YYYY-MM-DD}` and insert one `Notification[DailyReminder]`
 * carrying the per-ticket `severity` + `ageDays` (against `now`).
 */
export async function runDailyReminder(options: RunOptions = {}): Promise<RunResult> {
  const now = options.now ?? new Date();
  const dedupe = options.dedupe ?? defaultDedupe;

  if (isHolidaySkip(now, options.extraHolidays)) {
    return { skipped: 'holiday', agentsScanned: 0, notificationsInserted: 0 };
  }

  const agents = await prisma.user.findMany({
    where: { role: 'HelpdeskAgent', isActive: true },
    select: { id: true },
  });

  const dateKey = formatDateKey(now);
  let inserted = 0;

  for (const agent of agents) {
    const tickets = await prisma.ticket.findMany({
      where: {
        helpdeskAssigneeId: agent.id,
        status: { in: [...BACKLOG_STATUSES] },
      },
      select: { id: true, code: true, severity: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (tickets.length === 0) continue;

    const key = `reminder:${agent.id}:${dateKey}`;
    if (!(await dedupe.trySet(key))) continue;

    await prisma.notification.create({
      data: {
        userId: agent.id,
        type: 'DailyReminder',
        payload: {
          date: dateKey,
          ticketCount: tickets.length,
          tickets: tickets.map((t) => ({
            id: t.id,
            code: t.code,
            severity: t.severity,
            ageDays: Math.floor((now.getTime() - t.createdAt.getTime()) / MS_PER_DAY),
          })),
        },
      },
    });
    inserted += 1;
  }

  return { skipped: null, agentsScanned: agents.length, notificationsInserted: inserted };
}
