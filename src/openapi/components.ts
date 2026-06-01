import type { OpenAPIV3 } from 'openapi-types';

export const securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
  MockUserId: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Mock-User-Id',
    description: 'Mock SSO user id (dev only; replaced by real SSO session in prod).',
  },
  MockRole: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Mock-Role',
    description: 'Mock SSO role (one of: SV, GV, NV, HelpdeskLead, HelpdeskAgent, DeptStaff, Admin).',
  },
  MockDeptId: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Mock-Dept-Id',
    description: 'Mock SSO department id (used for DeptStaff scoping).',
  },
  JobBearer: {
    type: 'http',
    scheme: 'bearer',
    description: 'Shared `JOB_SECRET` (in prod: `CRON_SECRET` injected by Vercel) used to authenticate cron-invoked job endpoints.',
  },
};

const ENUM_SEVERITY = ['Critical', 'High', 'Medium', 'Low'] as const;
const ENUM_STATUS = ['Pending', 'Assigned', 'InProgress', 'Redirected', 'Closed'] as const;
const ENUM_ROLE = ['SV', 'GV', 'NV', 'HelpdeskLead', 'HelpdeskAgent', 'DeptStaff', 'Admin'] as const;
const ENUM_NOTIF = [
  'TicketClosed',
  'DailyReminder',
  'TicketAssigned',
  'TicketForwarded',
  'StatusChanged',
] as const;
const ENUM_KIND = ['Image', 'Document'] as const;
const ENUM_EVENT = [
  'Created',
  'AgentAssigned',
  'Forwarded',
  'Started',
  'Redirected',
  'SeverityChanged',
  'Commented',
  'Closed',
] as const;

export const schemas: Record<string, OpenAPIV3.SchemaObject> = {
  RequestId: {
    type: 'string',
    format: 'uuid',
    description: 'Echo of the X-Request-Id header (or a server-generated UUID).',
    example: '8f3a1e54-b71d-4f9f-a3a4-1f76b7c2e3a1',
  },
  Severity: { type: 'string', enum: [...ENUM_SEVERITY] },
  TicketStatus: { type: 'string', enum: [...ENUM_STATUS] },
  Role: { type: 'string', enum: [...ENUM_ROLE] },
  AttachmentKind: { type: 'string', enum: [...ENUM_KIND] },
  NotificationType: { type: 'string', enum: [...ENUM_NOTIF] },
  EventType: { type: 'string', enum: [...ENUM_EVENT] },

  ErrorBody: {
    type: 'object',
    required: ['code', 'message'],
    properties: {
      code: { type: 'string', example: 'validation_error' },
      message: { type: 'string', example: 'Dữ liệu không hợp lệ' },
      fields: {
        type: 'object',
        additionalProperties: { type: 'string' },
        nullable: true,
        description: 'Optional per-field error map (only populated for validation_error).',
      },
    },
  },
  ErrorEnvelope: {
    type: 'object',
    required: ['error', 'requestId'],
    properties: {
      error: { $ref: '#/components/schemas/ErrorBody' },
      requestId: { $ref: '#/components/schemas/RequestId' },
    },
  },

  Category: {
    type: 'object',
    required: ['id', 'name', 'isActive', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', example: 'ckxx0000000001' },
      name: { type: 'string', example: 'IT / Hệ thống số' },
      parentId: { type: 'string', nullable: true, example: null },
      isActive: { type: 'boolean', example: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  CreateCategoryRequest: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 120, example: 'IT mới' },
      parentId: { type: 'string', nullable: true, example: null },
    },
  },
  UpdateCategoryRequest: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 120 },
      isActive: { type: 'boolean' },
    },
  },

  RoutingRule: {
    type: 'object',
    required: ['id', 'categoryId', 'departmentId', 'isDefault', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string' },
      categoryId: { type: 'string' },
      departmentId: { type: 'string' },
      isDefault: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  CreateRoutingRuleRequest: {
    type: 'object',
    required: ['categoryId', 'departmentId'],
    properties: {
      categoryId: { type: 'string' },
      departmentId: { type: 'string' },
      isDefault: { type: 'boolean', default: false },
    },
  },
  UpdateRoutingRuleRequest: {
    type: 'object',
    properties: {
      departmentId: { type: 'string' },
      isDefault: { type: 'boolean' },
    },
  },

  Attachment: {
    type: 'object',
    required: [
      'id',
      'ticketId',
      'uploaderId',
      'filename',
      'mimeType',
      'kind',
      'sizeBytes',
      'storageKey',
      'createdAt',
    ],
    properties: {
      id: { type: 'string' },
      ticketId: { type: 'string' },
      commentId: { type: 'string', nullable: true },
      uploaderId: { type: 'string' },
      filename: { type: 'string', example: 'evidence.png' },
      mimeType: { type: 'string', example: 'image/png' },
      kind: { $ref: '#/components/schemas/AttachmentKind' },
      sizeBytes: { type: 'integer', example: 12345 },
      storageKey: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  Ticket: {
    type: 'object',
    required: [
      'id',
      'code',
      'title',
      'description',
      'severity',
      'status',
      'requesterId',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      code: { type: 'string', example: 'HD-2026-000001' },
      title: { type: 'string' },
      description: { type: 'string' },
      severity: { $ref: '#/components/schemas/Severity' },
      status: { $ref: '#/components/schemas/TicketStatus' },
      requesterId: { type: 'string' },
      categoryId: { type: 'string', nullable: true },
      helpdeskAssigneeId: { type: 'string', nullable: true },
      routedDepartmentId: { type: 'string', nullable: true },
      closedAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      attachments: {
        type: 'array',
        items: { $ref: '#/components/schemas/Attachment' },
      },
      category: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/Category' }],
      },
    },
  },
  CreateTicketRequest: {
    type: 'object',
    required: ['title', 'description', 'severity'],
    properties: {
      title: { type: 'string', minLength: 3, maxLength: 200, example: 'Mạng wifi không hoạt động' },
      description: {
        type: 'string',
        minLength: 5,
        maxLength: 5000,
        example: 'Phòng 502 không có wifi từ 7h sáng',
      },
      severity: { $ref: '#/components/schemas/Severity' },
      categoryId: { type: 'string', nullable: true },
      attachments: {
        type: 'array',
        items: { type: 'string', format: 'binary' },
        description: 'Multipart files. Max 10 files, ≤10MB each. Field name must be `attachments`.',
      },
    },
  },
  TicketListResponse: {
    type: 'object',
    required: ['items', 'page', 'pageSize', 'total'],
    properties: {
      items: { type: 'array', items: { $ref: '#/components/schemas/Ticket' } },
      page: { type: 'integer', minimum: 1 },
      pageSize: { type: 'integer', minimum: 1 },
      total: { type: 'integer', minimum: 0 },
    },
  },

  CountBucket: {
    type: 'object',
    required: ['key', 'count'],
    properties: {
      key: { type: 'string', description: 'Bucket key — an enum value or an entity id depending on the grouping.' },
      count: { type: 'integer', minimum: 0 },
    },
  },
  AnalyticsSummary: {
    type: 'object',
    required: ['total', 'open', 'closed', 'avgHandlingDays', 'bySeverity', 'byStatus', 'byDepartment', 'byCategory'],
    properties: {
      total: { type: 'integer', minimum: 0 },
      open: { type: 'integer', minimum: 0, description: 'Tickets not yet `Closed`.' },
      closed: { type: 'integer', minimum: 0 },
      avgHandlingDays: {
        type: 'number',
        nullable: true,
        description: 'Average `(closedAt - createdAt)` in days across closed tickets. `null` when there are no closed tickets.',
      },
      bySeverity: { type: 'array', items: { $ref: '#/components/schemas/CountBucket' } },
      byStatus: { type: 'array', items: { $ref: '#/components/schemas/CountBucket' } },
      byDepartment: {
        type: 'array',
        items: { $ref: '#/components/schemas/CountBucket' },
        description: 'Tickets with `routedDepartmentId=null` are excluded.',
      },
      byCategory: {
        type: 'array',
        items: { $ref: '#/components/schemas/CountBucket' },
        description: 'Tickets with `categoryId=null` are excluded.',
      },
    },
  },

  DailyReminderResult: {
    type: 'object',
    required: ['skipped', 'agentsScanned', 'notificationsInserted'],
    properties: {
      skipped: {
        type: 'string',
        nullable: true,
        enum: ['holiday'],
        description: '`"holiday"` when today was a weekend/public holiday and the run was a no-op; `null` on a normal run.',
      },
      agentsScanned: { type: 'integer', minimum: 0 },
      notificationsInserted: { type: 'integer', minimum: 0 },
    },
  },

  Notification: {
    type: 'object',
    required: ['id', 'userId', 'type', 'payload', 'createdAt'],
    properties: {
      id: { type: 'string' },
      userId: { type: 'string' },
      type: { $ref: '#/components/schemas/NotificationType' },
      ticketId: { type: 'string', nullable: true },
      payload: { type: 'object', additionalProperties: true, description: 'Free-form JSONB payload set when the notification was created.' },
      readAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  NotificationListResponse: {
    type: 'object',
    required: ['items', 'page', 'pageSize', 'total', 'unreadCount'],
    properties: {
      items: { type: 'array', items: { $ref: '#/components/schemas/Notification' } },
      page: { type: 'integer', minimum: 1 },
      pageSize: { type: 'integer', minimum: 1 },
      total: { type: 'integer', minimum: 0 },
      unreadCount: { type: 'integer', minimum: 0, description: 'Caller-scoped unread total (independent of filters).' },
    },
  },

  TicketComment: {
    type: 'object',
    required: ['id', 'ticketId', 'authorId', 'body', 'createdAt'],
    properties: {
      id: { type: 'string' },
      ticketId: { type: 'string' },
      authorId: { type: 'string' },
      body: { type: 'string', example: 'Tôi đã restart router, vẫn không lên mạng.' },
      createdAt: { type: 'string', format: 'date-time' },
      attachments: { type: 'array', items: { $ref: '#/components/schemas/Attachment' } },
    },
  },
  CreateCommentRequest: {
    type: 'object',
    required: ['body'],
    properties: {
      body: {
        type: 'string',
        minLength: 1,
        maxLength: 5000,
        description: 'Comment body. Trimmed; must be non-empty after trimming.',
        example: 'Tôi đã restart router, vẫn không lên mạng.',
      },
      attachments: {
        type: 'array',
        items: { type: 'string', format: 'binary' },
        description: 'Optional multipart files (≤10MB each, max 10). Same field name and limits as POST /tickets.',
      },
    },
  },
  AssignTicketRequest: {
    type: 'object',
    required: ['agentId'],
    properties: {
      agentId: {
        type: 'string',
        description: 'User id of a HelpdeskAgent who will own this ticket.',
      },
    },
  },
  ForwardTicketRequest: {
    type: 'object',
    required: ['departmentId'],
    properties: {
      departmentId: {
        type: 'string',
        description: 'Target department id for the initial routing.',
      },
    },
  },
  RedirectTicketRequest: {
    type: 'object',
    required: ['departmentId'],
    properties: {
      departmentId: {
        type: 'string',
        description: 'New department to route the ticket to.',
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: 'Optional human-readable reason; stored on the TicketEvent.note.',
      },
    },
  },
  CloseTicketRequest: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: 'Optional close note stored on the TicketEvent.',
      },
    },
  },
  OverrideSeverityRequest: {
    type: 'object',
    required: ['severity'],
    properties: {
      severity: { $ref: '#/components/schemas/Severity' },
    },
  },
  TicketEvent: {
    type: 'object',
    required: ['id', 'ticketId', 'actorId', 'type', 'createdAt'],
    properties: {
      id: { type: 'string' },
      ticketId: { type: 'string' },
      actorId: { type: 'string' },
      type: { $ref: '#/components/schemas/EventType' },
      fromStatus: { nullable: true, allOf: [{ $ref: '#/components/schemas/TicketStatus' }] },
      toStatus: { nullable: true, allOf: [{ $ref: '#/components/schemas/TicketStatus' }] },
      fromDepartmentId: { type: 'string', nullable: true },
      toDepartmentId: { type: 'string', nullable: true },
      note: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
};

function errorResponse(description: string, code: string, message: string): OpenAPIV3.ResponseObject {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorEnvelope' },
        example: {
          error: { code, message },
          requestId: '8f3a1e54-b71d-4f9f-a3a4-1f76b7c2e3a1',
        },
      },
    },
  };
}

export const responses: Record<string, OpenAPIV3.ResponseObject> = {
  Unauthorized401: errorResponse(
    'Caller is not authenticated (no/invalid SSO session).',
    'unauthenticated',
    'Yêu cầu xác thực',
  ),
  Forbidden403: errorResponse(
    'Caller is authenticated but lacks permission for this operation.',
    'forbidden',
    'Không có quyền truy cập',
  ),
  NotFound404: errorResponse('Resource not found.', 'not_found', 'Không tìm thấy'),
  Conflict409: errorResponse(
    'Operation conflicts with current state — stale status, delete-with-children, or duplicate constraint.',
    'conflict',
    'Xung đột trạng thái',
  ),
  PayloadTooLarge413: errorResponse(
    'A single uploaded file exceeded the 10MB limit, or more than 10 files were posted.',
    'payload_too_large',
    'File vượt quá giới hạn 10MB',
  ),
  Validation422: {
    description:
      'Validation error. `fields` maps each invalid input field to its human-readable message.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorEnvelope' },
        example: {
          error: {
            code: 'validation_error',
            message: 'Dữ liệu không hợp lệ',
            fields: { severity: 'Mức độ ưu tiên không hợp lệ' },
          },
          requestId: '8f3a1e54-b71d-4f9f-a3a4-1f76b7c2e3a1',
        },
      },
    },
  },
  ServiceUnavailable503: errorResponse(
    'Helpdesk module disabled via the HELPDESK_ENABLED feature flag (kill-switch). Healthz remains available.',
    'helpdesk_disabled',
    'Module Helpdesk tạm dừng',
  ),
  Internal500: errorResponse('Unhandled server error.', 'internal_error', 'Đã xảy ra lỗi máy chủ'),
};
