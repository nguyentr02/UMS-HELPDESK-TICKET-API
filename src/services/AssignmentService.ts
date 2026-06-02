import { prisma } from '../lib/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { TICKET_INCLUDE, toTicketDTO } from '../lib/dto.js';
import { assertCanPerform, TRANSITIONS } from '../lib/transitions.js';
import type { SessionUser } from '../middleware/auth.js';
import { UserService } from './UserService.js';

export const AssignmentService = {
  /**
   * Lead-only: assign (or reassign) a HelpdeskAgent to a ticket. Status doesn't
   * change (attribute-only mutation). Inserts `TicketEvent[AgentAssigned]` and
   * `Notification[TicketAssigned]` to the agent — all in one Prisma transaction
   * with an optimistic-status guard.
   */
  async assign(ticketId: string, agentId: string, caller: SessionUser) {
    await UserService.ensureFromSession(caller);

    const agent = await prisma.user.findUnique({ where: { id: agentId } });
    if (!agent) throw new ValidationError({ agentId: 'Agent không tồn tại' });
    if (agent.role !== 'HelpdeskAgent') {
      throw new ValidationError({ agentId: 'User được chọn không phải HelpdeskAgent' });
    }

    return prisma.$transaction(async (tx) => {
      const before = await tx.ticket.findUnique({ where: { id: ticketId } });
      if (!before) throw new NotFoundError('Không tìm thấy ticket');

      assertCanPerform('assign', caller, before);

      if (!TRANSITIONS.assign.allowedFrom.includes(before.status)) {
        throw new ConflictError(`Không thể assign khi ticket ở trạng thái ${before.status}`);
      }

      // Optimistic concurrency guard: only update if status is unchanged.
      const updated = await tx.ticket.updateMany({
        where: { id: ticketId, status: before.status },
        data: { helpdeskAssigneeId: agentId },
      });
      if (updated.count === 0) {
        throw new ConflictError('Trạng thái ticket đã thay đổi trong lúc xử lý');
      }

      await tx.ticketEvent.create({
        data: {
          ticketId,
          actorId: caller.id,
          type: 'AgentAssigned',
          fromStatus: before.status,
          toStatus: before.status,
          note: agentId,
        },
      });

      await tx.notification.create({
        data: {
          userId: agentId,
          type: 'TicketAssigned',
          ticketId,
          payload: { ticketCode: before.code, action: 'AgentAssigned' },
        },
      });

      // Notify the requester — their ticket has been picked up by an agent.
      // Use StatusChanged (the catch-all "your ticket moved" type) with the
      // assigned-agent id in the payload so the FE can deep-link if needed.
      if (before.requesterId !== caller.id) {
        await tx.notification.create({
          data: {
            userId: before.requesterId,
            type: 'StatusChanged',
            ticketId,
            payload: {
              ticketCode: before.code,
              status: before.status,
              assignedAgentId: agentId,
            },
          },
        });
      }

      return tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        include: TICKET_INCLUDE,
      });
    }).then(toTicketDTO);
  },
};
