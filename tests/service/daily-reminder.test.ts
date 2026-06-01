import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Severity, TicketStatus } from '@prisma/client';
import { runSeed } from '../../prisma/seed';
import { disconnect, resetDb, testPrisma as prisma } from '../helpers/test-db';
import { runDailyReminder } from '../../src/jobs/daily-reminder';
import { MemoryDedupe } from '../../src/lib/dedupe';

// Monday, 2026-06-01 02:00 UTC — not a weekend, not a default holiday.
const FIXED_MONDAY = new Date('2026-06-01T02:00:00.000Z');

interface ReminderPayload {
  date: string;
  ticketCount: number;
  tickets: Array<{ id: string; code: string; severity: Severity; ageDays: number }>;
}

async function seedAgent(id: string) {
  await prisma.user.upsert({
    where: { id },
    create: {
      id,
      ssoSubject: `mock:${id}`,
      email: `${id}@mock.local`,
      displayName: id,
      role: 'HelpdeskAgent',
      departmentId: null,
    },
    update: {},
  });
}

async function ensureRequester() {
  await prisma.user.upsert({
    where: { id: 'u-sv-1' },
    create: {
      id: 'u-sv-1',
      ssoSubject: 'mock:u-sv-1',
      email: 'u-sv-1@mock.local',
      displayName: 'sv-1',
      role: 'SV',
      departmentId: null,
    },
    update: {},
  });
}

async function seedTicket(opts: {
  code: string;
  status: TicketStatus;
  severity: Severity;
  agentId: string;
  ageDays?: number;
}) {
  await ensureRequester();
  const createdAt = opts.ageDays !== undefined
    ? new Date(FIXED_MONDAY.getTime() - opts.ageDays * 86_400_000)
    : FIXED_MONDAY;
  return prisma.ticket.create({
    data: {
      code: opts.code,
      title: opts.code,
      description: opts.code,
      severity: opts.severity,
      status: opts.status,
      requesterId: 'u-sv-1',
      helpdeskAssigneeId: opts.agentId,
      createdAt,
    },
  });
}

describe('BE-S8 — Daily reminder handler', () => {
  beforeEach(async () => {
    await resetDb();
    await runSeed(prisma);
  });
  afterAll(async () => {
    await disconnect();
  });

  it('M31-BE-S8-H1: 1 agent owning 3 backlog tickets → 1 DailyReminder; payload lists all 3 with severity + ageDays', async () => {
    await seedAgent('u-agent-1');
    await seedTicket({ code: 'HD-2026-A001', status: 'Pending', severity: 'High', agentId: 'u-agent-1', ageDays: 2 });
    await seedTicket({ code: 'HD-2026-A002', status: 'Assigned', severity: 'Medium', agentId: 'u-agent-1', ageDays: 1 });
    await seedTicket({ code: 'HD-2026-A003', status: 'Redirected', severity: 'Low', agentId: 'u-agent-1', ageDays: 0 });

    const result = await runDailyReminder({ now: FIXED_MONDAY, dedupe: new MemoryDedupe() });
    expect(result).toMatchObject({ skipped: null, agentsScanned: 1, notificationsInserted: 1 });

    const notifs = await prisma.notification.findMany({
      where: { userId: 'u-agent-1', type: 'DailyReminder' },
    });
    expect(notifs).toHaveLength(1);
    const payload = notifs[0]!.payload as unknown as ReminderPayload;
    expect(payload.ticketCount).toBe(3);
    expect(payload.tickets.map((t) => t.code).sort()).toEqual([
      'HD-2026-A001',
      'HD-2026-A002',
      'HD-2026-A003',
    ]);
    // Each entry has severity + ageDays
    expect(payload.tickets.find((t) => t.code === 'HD-2026-A001')).toMatchObject({ severity: 'High', ageDays: 2 });
    expect(payload.tickets.find((t) => t.code === 'HD-2026-A002')).toMatchObject({ severity: 'Medium', ageDays: 1 });
  });

  it('M31-BE-S8-E1: agent with 0 backlog → no notification', async () => {
    await seedAgent('u-agent-empty');
    const result = await runDailyReminder({ now: FIXED_MONDAY, dedupe: new MemoryDedupe() });
    expect(result.notificationsInserted).toBe(0);
    const count = await prisma.notification.count({ where: { type: 'DailyReminder' } });
    expect(count).toBe(0);
  });

  it('M31-BE-S8-E2: InProgress / Closed tickets are excluded from the payload', async () => {
    await seedAgent('u-agent-mix');
    await seedTicket({ code: 'HD-2026-M-PEN', status: 'Pending', severity: 'Low', agentId: 'u-agent-mix' });
    await seedTicket({ code: 'HD-2026-M-INP', status: 'InProgress', severity: 'Low', agentId: 'u-agent-mix' });
    await seedTicket({ code: 'HD-2026-M-CLO', status: 'Closed', severity: 'Low', agentId: 'u-agent-mix' });

    await runDailyReminder({ now: FIXED_MONDAY, dedupe: new MemoryDedupe() });
    const notif = await prisma.notification.findFirstOrThrow({
      where: { userId: 'u-agent-mix', type: 'DailyReminder' },
    });
    const payload = notif.payload as unknown as ReminderPayload;
    expect(payload.ticketCount).toBe(1);
    expect(payload.tickets.map((t) => t.code)).toEqual(['HD-2026-M-PEN']);
  });

  it('M31-BE-S8-E3: invocation on a holiday → skip; no notifications created', async () => {
    await seedAgent('u-agent-1');
    await seedTicket({ code: 'HD-2026-H', status: 'Pending', severity: 'Low', agentId: 'u-agent-1' });

    const result = await runDailyReminder({
      now: FIXED_MONDAY,
      dedupe: new MemoryDedupe(),
      extraHolidays: new Set(['06-01']),
    });
    expect(result.skipped).toBe('holiday');
    expect(result.notificationsInserted).toBe(0);
    const notifs = await prisma.notification.findMany({ where: { type: 'DailyReminder' } });
    expect(notifs).toHaveLength(0);
  });

  it('M31-BE-S8-X1: second invocation same date → dedupe; only one notification per agent per day', async () => {
    await seedAgent('u-agent-1');
    await seedTicket({ code: 'HD-2026-D', status: 'Pending', severity: 'Low', agentId: 'u-agent-1' });
    const dedupe = new MemoryDedupe();

    const r1 = await runDailyReminder({ now: FIXED_MONDAY, dedupe });
    const r2 = await runDailyReminder({ now: FIXED_MONDAY, dedupe });
    expect(r1.notificationsInserted).toBe(1);
    expect(r2.notificationsInserted).toBe(0);

    const notifs = await prisma.notification.findMany({
      where: { userId: 'u-agent-1', type: 'DailyReminder' },
    });
    expect(notifs).toHaveLength(1);
  });

  it('M31-BE-S8-X2: ageDays is computed against the injected clock (deterministic)', async () => {
    await seedAgent('u-agent-1');
    await seedTicket({ code: 'HD-2026-AGE', status: 'Pending', severity: 'Low', agentId: 'u-agent-1', ageDays: 5 });

    await runDailyReminder({ now: FIXED_MONDAY, dedupe: new MemoryDedupe() });
    const notif = await prisma.notification.findFirstOrThrow({
      where: { userId: 'u-agent-1', type: 'DailyReminder' },
    });
    const payload = notif.payload as unknown as ReminderPayload;
    expect(payload.tickets[0]?.ageDays).toBe(5);
  });

  it('M31-BE-S8-I1: 3 agents with backlogs 0 / 2 / 4 → per-agent counts match', async () => {
    await seedAgent('u-a-zero');
    await seedAgent('u-a-two');
    await seedAgent('u-a-four');

    for (let i = 0; i < 2; i++) {
      await seedTicket({ code: `HD-2026-T${i}`, status: 'Pending', severity: 'Low', agentId: 'u-a-two' });
    }
    for (let i = 0; i < 4; i++) {
      await seedTicket({ code: `HD-2026-F${i}`, status: 'Assigned', severity: 'Medium', agentId: 'u-a-four' });
    }

    const result = await runDailyReminder({ now: FIXED_MONDAY, dedupe: new MemoryDedupe() });
    expect(result.agentsScanned).toBe(3);
    expect(result.notificationsInserted).toBe(2); // zero-backlog agent gets nothing

    const zero = await prisma.notification.count({ where: { userId: 'u-a-zero', type: 'DailyReminder' } });
    expect(zero).toBe(0);

    const two = await prisma.notification.findFirstOrThrow({
      where: { userId: 'u-a-two', type: 'DailyReminder' },
    });
    expect((two.payload as unknown as ReminderPayload).ticketCount).toBe(2);

    const four = await prisma.notification.findFirstOrThrow({
      where: { userId: 'u-a-four', type: 'DailyReminder' },
    });
    expect((four.payload as unknown as ReminderPayload).ticketCount).toBe(4);
  });
});
