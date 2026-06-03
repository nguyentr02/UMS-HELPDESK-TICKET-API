import type { OpenAPIV3 } from 'openapi-types';

const REQUEST_ID_EX = '8f3a1e54-b71d-4f9f-a3a4-1f76b7c2e3a1';

const envelope = (data: unknown) => ({ data, requestId: REQUEST_ID_EX });

const EX_CATEGORY = {
  id: 'ckxx0000000001',
  name: 'IT / Hệ thống số',
  isActive: true,
  createdAt: '2026-06-01T03:00:00.000Z',
  updatedAt: '2026-06-01T03:00:00.000Z',
};

const EX_TICKET = {
  id: 'ckxx0000000002',
  code: 'HD-2026-000001',
  title: 'Mạng wifi không hoạt động',
  description: 'Phòng 502 không có wifi từ 7h sáng',
  severity: 'High',
  status: 'Pending',
  requesterId: 'u-sv-1',
  categoryId: null,
  helpdeskAssigneeId: null,
  routedDepartmentId: null,
  closedAt: null,
  createdAt: '2026-06-01T03:00:00.000Z',
  updatedAt: '2026-06-01T03:00:00.000Z',
  attachments: [],
};

const EX_EVENT = {
  id: 'evt-1',
  ticketId: EX_TICKET.id,
  actorId: 'u-sv-1',
  type: 'Created',
  toStatus: 'Pending',
  createdAt: '2026-06-01T03:00:00.000Z',
};

const SECURITY: OpenAPIV3.SecurityRequirementObject[] = [{ MockUserId: [], MockRole: [] }];

const ENVELOPE_SCHEMA = (dataRef: string): OpenAPIV3.SchemaObject => ({
  type: 'object',
  required: ['data', 'requestId'],
  properties: {
    data: { $ref: dataRef },
    requestId: { $ref: '#/components/schemas/RequestId' },
  },
});

const ENVELOPE_ARRAY = (itemRef: string): OpenAPIV3.SchemaObject => ({
  type: 'object',
  required: ['data', 'requestId'],
  properties: {
    data: { type: 'array', items: { $ref: itemRef } },
    requestId: { $ref: '#/components/schemas/RequestId' },
  },
});

const ENVELOPE_ID: OpenAPIV3.SchemaObject = {
  type: 'object',
  required: ['data', 'requestId'],
  properties: {
    data: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    requestId: { $ref: '#/components/schemas/RequestId' },
  },
};

export const paths: OpenAPIV3.PathsObject = {
  '/healthz': {
    get: {
      tags: ['Healthz'],
      summary: 'Liveness probe.',
      description:
        'Returns 200 unconditionally. **Not** gated by the HELPDESK_ENABLED kill-switch — monitoring continues to receive 200 even when the module is disabled. Public; no authentication required. No rate limit.',
      security: [],
      responses: {
        '200': {
          description: 'Service is up.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { status: { type: 'string', example: 'ok' } },
              },
              example: { status: 'ok' },
            },
          },
        },
      },
    },
  },

  '/categories': {
    get: {
      tags: ['Categories'],
      summary: 'List all categories.',
      description:
        'Lists every category (top-level + children). Permission: any authenticated user. No rate limit (read-only).',
      security: SECURITY,
      responses: {
        '200': {
          description: 'Categories.',
          content: {
            'application/json': {
              schema: ENVELOPE_ARRAY('#/components/schemas/Category'),
              example: envelope([EX_CATEGORY]),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
    post: {
      tags: ['Categories'],
      summary: 'Create a category.',
      description:
        'Creates a new (flat) category. Permission: **Admin** only. Rate limit: standard write.',
      security: SECURITY,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateCategoryRequest' },
            example: { name: 'IT mới' },
          },
        },
      },
      responses: {
        '201': {
          description: 'Category created.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/Category'),
              example: envelope(EX_CATEGORY),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '422': { $ref: '#/components/responses/Validation422' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/categories/{id}': {
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Category id (cuid).',
      },
    ],
    patch: {
      tags: ['Categories'],
      summary: 'Update a category.',
      description: 'Update `name` and/or `isActive`. Permission: **Admin** only.',
      security: SECURITY,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateCategoryRequest' },
            example: { name: 'IT - Hệ thống số (đổi tên)' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/Category'),
              example: envelope({ ...EX_CATEGORY, name: 'IT - Hệ thống số (đổi tên)' }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '422': { $ref: '#/components/responses/Validation422' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
    delete: {
      tags: ['Categories'],
      summary: 'Delete a category.',
      description:
        'Deletes a category. **Returns 409 if the category has child categories** (delete guard). Permission: **Admin** only.',
      security: SECURITY,
      responses: {
        '200': {
          description: 'Deleted.',
          content: {
            'application/json': {
              schema: ENVELOPE_ID,
              example: envelope({ id: EX_CATEGORY.id }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '409': { $ref: '#/components/responses/Conflict409' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/tickets': {
    post: {
      tags: ['Tickets'],
      summary: 'Create a ticket.',
      description:
        'Submits a new ticket on behalf of the calling user (the requester is **server-derived** from the session — any client-supplied `requesterId` is ignored). Multipart `attachments` field accepts up to 5 files, ≤10 MB each. Permission: any authenticated role. Rate limit: standard write.',
      security: SECURITY,
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: { $ref: '#/components/schemas/CreateTicketRequest' },
            encoding: {
              attachments: { contentType: 'application/octet-stream', style: 'form' },
            },
            example: {
              title: 'Mạng wifi không hoạt động',
              description: 'Phòng 502 không có wifi từ 7h sáng',
              severity: 'High',
              categoryId: null,
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Created.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/Ticket'),
              example: envelope(EX_TICKET),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '413': { $ref: '#/components/responses/PayloadTooLarge413' },
        '422': { $ref: '#/components/responses/Validation422' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
    get: {
      tags: ['Tickets'],
      summary: 'List tickets (server-scoped).',
      description:
        'Lists tickets scoped to the caller:\n\n- **SV / GV / NV** — only their own.\n- **HelpdeskLead / HelpdeskAgent / Admin** — all tickets.\n- **DeptStaff** — tickets routed to their department.\n\n**Any client-supplied `departmentId` is ignored** — scope is always derived from the session. Filters: `status` accepts `open` (the four non-Closed) or a comma-separated list of statuses; `severity` accepts a comma-separated list. Pagination defaults: `page=1`, `pageSize=20` (max 100).',
      security: SECURITY,
      parameters: [
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: '`open` (Pending|Assigned|InProgress) or comma-separated statuses (e.g. `Pending,Assigned`).',
          example: 'open',
        },
        {
          name: 'severity',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'Comma-separated severities (e.g. `Critical,High`).',
          example: 'Critical,High',
        },
        {
          name: 'page',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, default: 1 },
          description: '1-based page number.',
        },
        {
          name: 'pageSize',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          description: 'Page size (max 100).',
        },
      ],
      responses: {
        '200': {
          description: 'Paged tickets.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/TicketListResponse'),
              example: envelope({ items: [EX_TICKET], page: 1, pageSize: 20, total: 1 }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/tickets/{id}': {
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Ticket id (cuid).',
      },
    ],
    get: {
      tags: ['Tickets'],
      summary: 'Get a ticket by id (scoped).',
      description:
        'Returns ticket detail with attachments and category. Visible to: the **requester**, any **Helpdesk** role, **Admin**, and **DeptStaff** when the ticket is routed to their department. Otherwise 403.',
      security: SECURITY,
      responses: {
        '200': {
          description: 'Ticket detail.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/Ticket'),
              example: envelope(EX_TICKET),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/tickets/{id}/history': {
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Ticket id (cuid).',
      },
    ],
    get: {
      tags: ['Tickets'],
      summary: 'Ticket event history (scoped).',
      description:
        'Returns the chronological event log for the ticket (Created → AgentAssigned → Forwarded → Started → Closed, etc.). Same scoping as `GET /tickets/{id}`.',
      security: SECURITY,
      responses: {
        '200': {
          description: 'Event list.',
          content: {
            'application/json': {
              schema: ENVELOPE_ARRAY('#/components/schemas/TicketEvent'),
              example: envelope([EX_EVENT]),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/tickets/{id}/assign': {
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Ticket id.' },
    ],
    post: {
      tags: ['Tickets'],
      summary: 'Assign (or reassign) a HelpdeskAgent.',
      description:
        'Attribute-only mutation — status does not change. Allowed only while the ticket is **Pending**. Permission: **HelpdeskLead** only. Inserts `TicketEvent[AgentAssigned]` and a `Notification[TicketAssigned]` to the agent. Rate limit: standard write.',
      security: SECURITY,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/AssignTicketRequest' },
            example: { agentId: 'u-agent-1' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Ticket updated with `helpdeskAssigneeId`.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/Ticket'),
              example: envelope({ ...EX_TICKET, helpdeskAssigneeId: 'u-agent-1' }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '409': { $ref: '#/components/responses/Conflict409' },
        '422': { $ref: '#/components/responses/Validation422' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/tickets/{id}/forward': {
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Ticket id.' },
    ],
    post: {
      tags: ['Tickets'],
      summary: 'Forward to a department.',
      description:
        'Transition `Pending → Assigned`. Sets `routedDepartmentId`. Permission: **HelpdeskLead** or **HelpdeskAgent**. Inserts `TicketEvent[Forwarded]` and one `Notification[TicketForwarded]` per active DeptStaff in the target department. **Concurrency:** two concurrent forwards on the same ticket — the loser gets `409 conflict` and writes nothing.',
      security: SECURITY,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ForwardTicketRequest' },
            example: { departmentId: 'dept-csvc' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Ticket routed.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/Ticket'),
              example: envelope({ ...EX_TICKET, status: 'Assigned', routedDepartmentId: 'dept-csvc' }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '409': { $ref: '#/components/responses/Conflict409' },
        '422': { $ref: '#/components/responses/Validation422' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/tickets/{id}/progress': {
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Ticket id.' },
    ],
    post: {
      tags: ['Tickets'],
      summary: 'Start progress.',
      description:
        'Transition `Assigned → InProgress`. Permission: **DeptStaff** of the routed department, or **HelpdeskLead** / **HelpdeskAgent**. Inserts `TicketEvent[Started]` and `Notification[StatusChanged]` to the requester.',
      security: SECURITY,
      responses: {
        '200': {
          description: 'Ticket moved to InProgress.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/Ticket'),
              example: envelope({ ...EX_TICKET, status: 'InProgress' }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '409': { $ref: '#/components/responses/Conflict409' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/tickets/{id}/close': {
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Ticket id.' },
    ],
    post: {
      tags: ['Tickets'],
      summary: 'Close a ticket (terminal).',
      description:
        'Transition any non-Closed → `Closed`. Sets `closedAt`. **No reopen.** Permission: **HelpdeskLead** OR the **assigned HelpdeskAgent** (per-ticket check). Inserts `TicketEvent[Closed]` and `Notification[TicketClosed]` to the requester.',
      security: SECURITY,
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CloseTicketRequest' },
            example: { reason: 'Đã khôi phục wifi cho phòng 502' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Ticket closed.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/Ticket'),
              example: envelope({
                ...EX_TICKET,
                status: 'Closed',
                closedAt: '2026-06-01T05:00:00.000Z',
              }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '409': { $ref: '#/components/responses/Conflict409' },
        '422': { $ref: '#/components/responses/Validation422' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/tickets/{id}/severity': {
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Ticket id.' },
    ],
    patch: {
      tags: ['Tickets'],
      summary: 'Override the ticket severity.',
      description:
        'Updates `severity` on any non-Closed ticket. No status change. Inserts `TicketEvent[SeverityChanged]` with `fromSeverity → toSeverity` in the `note` field. Permission: **HelpdeskLead** or **HelpdeskAgent**.',
      security: SECURITY,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/OverrideSeverityRequest' },
            example: { severity: 'Low' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Severity updated.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/Ticket'),
              example: envelope({ ...EX_TICKET, severity: 'Low' }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '409': { $ref: '#/components/responses/Conflict409' },
        '422': { $ref: '#/components/responses/Validation422' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/tickets/{id}/comments': {
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Ticket id.' },
    ],
    post: {
      tags: ['Tickets'],
      summary: 'Add a comment (with optional attachments).',
      description:
        'Appends a comment to the ticket and writes `TicketEvent[Commented]` in the same Prisma transaction. Optional `attachments` go through the same multer pipeline as `POST /tickets` (≤10 MB per file, max 5) and are tied to the new comment id. **Permission:** anyone who can view the ticket (requester / Helpdesk / Admin / DeptStaff of the routed dept). **Blocked when status=Closed → 409.** Rate limit: standard write.',
      security: SECURITY,
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: { $ref: '#/components/schemas/CreateCommentRequest' },
            encoding: {
              attachments: { contentType: 'application/octet-stream', style: 'form' },
            },
            example: { body: 'Tôi đã restart router, vẫn không lên mạng.' },
          },
        },
      },
      responses: {
        '201': {
          description: 'Comment created.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/TicketComment'),
              example: envelope({
                id: 'cmt-1',
                ticketId: EX_TICKET.id,
                authorId: 'u-sv-1',
                body: 'Tôi đã restart router, vẫn không lên mạng.',
                createdAt: '2026-06-01T03:30:00.000Z',
                attachments: [],
              }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '409': { $ref: '#/components/responses/Conflict409' },
        '413': { $ref: '#/components/responses/PayloadTooLarge413' },
        '422': { $ref: '#/components/responses/Validation422' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/notifications': {
    get: {
      tags: ['Notifications'],
      summary: 'Inbox for the calling user.',
      description:
        'Returns the caller\'s own notifications. **Sort:** unread (`readAt=NULL`) first, then `createdAt DESC` within each group. `unreadCount` is the caller\'s total unread (independent of filters / paging). **Permission:** any authenticated user, but only sees their own (server-side scoping — no `userId` query param accepted). Pagination defaults: `page=1`, `pageSize=20` (max 100).',
      security: SECURITY,
      parameters: [
        { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 }, description: '1-based page number.' },
        { name: 'pageSize', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'unreadOnly', in: 'query', required: false, schema: { type: 'boolean', default: false }, description: 'When `true`, restrict items to unread only.' },
      ],
      responses: {
        '200': {
          description: 'Notifications inbox.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/NotificationListResponse'),
              example: envelope({
                items: [
                  {
                    id: 'notif-1',
                    userId: 'u-sv-1',
                    type: 'TicketClosed',
                    ticketId: EX_TICKET.id,
                    payload: { ticketCode: 'HD-2026-000001', reason: 'Đã sửa' },
                    readAt: null,
                    createdAt: '2026-06-01T05:00:00.000Z',
                  },
                ],
                page: 1,
                pageSize: 20,
                total: 1,
                unreadCount: 1,
              }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/notifications/{id}/read': {
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Notification id.' },
    ],
    post: {
      tags: ['Notifications'],
      summary: 'Mark a notification as read.',
      description:
        'Sets `readAt` to the current server time. Idempotent — a second call returns the already-read row unchanged. **Permission:** only the recipient (`notification.userId === caller.id`); any other user gets `403`.',
      security: SECURITY,
      responses: {
        '200': {
          description: 'Notification updated (or already-read, unchanged).',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/Notification'),
              example: envelope({
                id: 'notif-1',
                userId: 'u-sv-1',
                type: 'TicketClosed',
                ticketId: EX_TICKET.id,
                payload: { ticketCode: 'HD-2026-000001' },
                readAt: '2026-06-01T05:30:00.000Z',
                createdAt: '2026-06-01T05:00:00.000Z',
              }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/analytics/summary': {
    get: {
      tags: ['Analytics'],
      summary: 'Aggregated counts across the ticket table.',
      description:
        'Single-shot summary used by the Helpdesk dashboard. Returns total / open / closed, `avgHandlingDays` across closed tickets (or `null` if none), and per-bucket counts grouped by severity, status, department, and category. **Permission:** `HelpdeskLead`, `HelpdeskAgent`, `Admin` only — `SV/GV/NV/DeptStaff` get `403`. **No rate limit** (read-only, cheap).',
      security: SECURITY,
      responses: {
        '200': {
          description: 'Aggregated counts.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/AnalyticsSummary'),
              example: envelope({
                total: 12,
                open: 9,
                closed: 3,
                avgHandlingDays: 1.84,
                bySeverity: [
                  { key: 'Critical', count: 1 },
                  { key: 'High', count: 4 },
                  { key: 'Medium', count: 5 },
                  { key: 'Low', count: 2 },
                ],
                byStatus: [
                  { key: 'Pending', count: 3 },
                  { key: 'Assigned', count: 4 },
                  { key: 'InProgress', count: 2 },
                  { key: 'Closed', count: 3 },
                ],
                byDepartment: [
                  { key: 'dept-csvc', count: 5 },
                  { key: 'dept-hcns', count: 4 },
                ],
                byCategory: [
                  { key: 'cat-it', count: 7 },
                  { key: 'cat-csvc', count: 2 },
                ],
              }),
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '500': {
          description: 'Aggregation pipeline failed. The original cause is logged server-side, not exposed.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              example: {
                error: { code: 'analytics_failed', message: 'Lỗi tổng hợp dữ liệu phân tích' },
                requestId: '8f3a1e54-b71d-4f9f-a3a4-1f76b7c2e3a1',
              },
            },
          },
        },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/jobs/daily-reminder': {
    post: {
      tags: ['Jobs'],
      summary: 'Run the daily backlog reminder.',
      description:
        'Single source of truth shared by the local bullmq worker and the Vercel-Cron-invoked deploy. For each active HelpdeskAgent, queries backlog tickets in `{Pending, Assigned}` and inserts at most one `Notification[DailyReminder]` per agent per day, deduped by `reminder:{agentId}:{YYYY-MM-DD}`. Skips weekends + holidays. **Authentication:** `Authorization: Bearer $JOB_SECRET` (in prod, `CRON_SECRET` injected by Vercel). Anything else → `403`. Not user-facing; gated by the helpdesk kill-switch.',
      security: [{ JobBearer: [] }],
      responses: {
        '200': {
          description: 'Run summary.',
          content: {
            'application/json': {
              schema: ENVELOPE_SCHEMA('#/components/schemas/DailyReminderResult'),
              example: envelope({ skipped: null, agentsScanned: 5, notificationsInserted: 3 }),
            },
          },
        },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },

  '/attachments/{id}': {
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Attachment id (cuid).',
      },
    ],
    get: {
      tags: ['Attachments'],
      summary: 'Download an attachment (scoped).',
      description:
        'Streams the file bytes with the original `Content-Type` and `Content-Disposition: attachment; filename=…`. Same scoping rules as the parent ticket (`GET /tickets/{id}`). No rate limit specified.',
      security: SECURITY,
      responses: {
        '200': {
          description: 'File stream.',
          content: {
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized401' },
        '403': { $ref: '#/components/responses/Forbidden403' },
        '404': { $ref: '#/components/responses/NotFound404' },
        '500': { $ref: '#/components/responses/Internal500' },
        '503': { $ref: '#/components/responses/ServiceUnavailable503' },
      },
    },
  },
};
