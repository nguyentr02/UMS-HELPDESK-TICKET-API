import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../lib/envelope.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { uploadAttachments } from '../middleware/upload.js';
import { zodValidate } from '../middleware/zodValidate.js';
import { TicketService } from '../services/TicketService.js';
import { AssignmentService } from '../services/AssignmentService.js';
import { AttachmentService } from '../services/AttachmentService.js';

const SEVERITY = ['Critical', 'High', 'Medium', 'Low'] as const;

const assignBody = z.object({ agentId: z.string().min(1) });
const forwardBody = z.object({ departmentId: z.string().min(1) });
const redirectBody = z.object({
  departmentId: z.string().min(1),
  reason: z.string().trim().min(1).max(2000).optional(),
});
// FE sends `note`; legacy `reason` accepted too for the §8.3 spec example.
const closeBody = z
  .object({
    note: z.string().trim().min(1).max(2000).optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .transform((b) => ({ note: b.note ?? b.reason }));

// Pre-uploaded attachment metadata (Vercel Blob direct-upload flow). The
// browser uploads to Blob first, then posts the resulting URLs here so the
// request body stays under Vercel's 4.5 MB function-body limit.
const attachmentMetaSchema = z.object({
  url: z.string().url(),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(127),
  sizeBytes: z.number().int().nonnegative().max(10 * 1024 * 1024),
});
const attachmentsArraySchema = z.array(attachmentMetaSchema).max(5).optional();
const severityBody = z.object({ severity: z.enum(SEVERITY) });
const commentBody = z.object({
  body: z.string().trim().min(1, 'Nội dung bình luận không được rỗng').max(5000),
  attachments: attachmentsArraySchema,
});

const createBody = z.object({
  title: z.string().trim().min(3, 'Tiêu đề tối thiểu 3 ký tự').max(200),
  description: z.string().trim().min(5, 'Mô tả tối thiểu 5 ký tự').max(5000),
  severity: z.enum(SEVERITY, { message: 'Mức độ ưu tiên không hợp lệ' }),
  categoryId: z.string().min(1).nullable().optional(),
  attachments: attachmentsArraySchema,
});

export const ticketsRouter = Router();

ticketsRouter.post(
  '/tickets',
  requireAuth,
  uploadAttachments,
  zodValidate(createBody),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined)?.map((f) => ({
      originalname: f.originalname,
      mimetype: f.mimetype,
      buffer: f.buffer,
      size: f.size,
    }));
    const ticket = await TicketService.create(
      {
        title: req.body.title,
        description: req.body.description,
        severity: req.body.severity,
        categoryId: req.body.categoryId,
        files,
        attachments: req.body.attachments,
      },
      req.user!,
    );
    res.status(201).json(ok(ticket, req.requestId));
  }),
);

ticketsRouter.get(
  '/tickets',
  requireAuth,
  asyncHandler(async (req, res) => {
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const result = await TicketService.list(
      {
        status: str(req.query.status),
        severity: str(req.query.severity),
        categoryId: str(req.query.categoryId),
        assigneeId: str(req.query.assigneeId),
        q: str(req.query.q),
        sort: str(req.query.sort),
        page: req.query.page !== undefined ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize !== undefined ? Number(req.query.pageSize) : undefined,
      },
      req.user!,
    );
    res.json(ok(result, req.requestId));
  }),
);

ticketsRouter.get(
  '/tickets/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ticket = await TicketService.getById(req.params.id, req.user!);
    res.json(ok(ticket, req.requestId));
  }),
);

ticketsRouter.get(
  '/tickets/:id/history',
  requireAuth,
  asyncHandler(async (req, res) => {
    const history = await TicketService.getHistory(req.params.id, req.user!);
    res.json(ok(history, req.requestId));
  }),
);

// ─────────────── State-machine transitions (BE-S5) ───────────────

ticketsRouter.post(
  '/tickets/:id/assign',
  requireAuth,
  zodValidate(assignBody),
  asyncHandler(async (req, res) => {
    const ticket = await AssignmentService.assign(req.params.id, req.body.agentId, req.user!);
    res.json(ok(ticket, req.requestId));
  }),
);

ticketsRouter.post(
  '/tickets/:id/forward',
  requireAuth,
  zodValidate(forwardBody),
  asyncHandler(async (req, res) => {
    const ticket = await TicketService.forward(req.params.id, req.body.departmentId, req.user!);
    res.json(ok(ticket, req.requestId));
  }),
);

ticketsRouter.post(
  '/tickets/:id/redirect',
  requireAuth,
  zodValidate(redirectBody),
  asyncHandler(async (req, res) => {
    const ticket = await TicketService.redirect(
      req.params.id,
      req.body.departmentId,
      req.body.reason,
      req.user!,
    );
    res.json(ok(ticket, req.requestId));
  }),
);

ticketsRouter.post(
  '/tickets/:id/progress',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ticket = await TicketService.startProgress(req.params.id, req.user!);
    res.json(ok(ticket, req.requestId));
  }),
);

ticketsRouter.post(
  '/tickets/:id/close',
  requireAuth,
  zodValidate(closeBody),
  asyncHandler(async (req, res) => {
    const ticket = await TicketService.close(req.params.id, req.body.note, req.user!);
    res.json(ok(ticket, req.requestId));
  }),
);

ticketsRouter.patch(
  '/tickets/:id/severity',
  requireAuth,
  zodValidate(severityBody),
  asyncHandler(async (req, res) => {
    const ticket = await TicketService.overrideSeverity(req.params.id, req.body.severity, req.user!);
    res.json(ok(ticket, req.requestId));
  }),
);

// ─────────────── Comments (BE-S6) ───────────────

ticketsRouter.post(
  '/tickets/:id/comments',
  requireAuth,
  uploadAttachments,
  zodValidate(commentBody),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined)?.map((f) => ({
      originalname: f.originalname,
      mimetype: f.mimetype,
      buffer: f.buffer,
      size: f.size,
    }));
    const comment = await TicketService.addComment(
      req.params.id,
      req.body.body,
      files,
      req.body.attachments,
      req.user!,
    );
    res.status(201).json(ok(comment, req.requestId));
  }),
);

ticketsRouter.get(
  '/attachments/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const file = await AttachmentService.download(req.params.id, req.user!);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.filename)}"`,
    );
    res.setHeader('Content-Length', String(file.sizeBytes));
    file.stream.pipe(res);
  }),
);
