import type { NextFunction, Request, Response } from 'express';
import { newRequestId } from '../lib/envelope';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Unique per-request id; honoured from `X-Request-Id` or generated.
       *  Named `requestId` (not `id`) to avoid clashing with `pino-http`'s
       *  `req.id: ReqId = string | number`. */
      requestId: string;
    }
  }
}

/** Reads `X-Request-Id` if present, otherwise generates one; echoes it on the response. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = (req.header('x-request-id') ?? '').trim();
  const id = incoming || newRequestId();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
