import type { ErrorRequestHandler } from 'express';
import { fail } from '../lib/envelope';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

/** Final error handler. Shapes every thrown error into the envelope. */
export const errorMiddleware: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.requestId ?? '';

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ requestId, err }, 'app error 5xx');
    }
    return res.status(err.status).json(
      fail(
        {
          code: err.code,
          message: err.message,
          ...(err.fields ? { fields: err.fields } : {}),
        },
        requestId,
      ),
    );
  }

  logger.error({ requestId, err }, 'unhandled error');
  res
    .status(500)
    .json(fail({ code: 'internal_error', message: 'Đã xảy ra lỗi máy chủ' }, requestId));
};
