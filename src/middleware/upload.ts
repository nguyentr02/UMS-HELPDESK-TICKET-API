import type { RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../lib/errors';

const FIELD = 'attachments';
const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: MAX_FILES },
});

/**
 * Parses `multipart/form-data` with attachments. MulterError is translated to
 * a stable AppError envelope (`413 payload_too_large` etc.) so clients see
 * one consistent error shape across the API.
 */
export const uploadAttachments: RequestHandler = (req, res, next) => {
  upload.array(FIELD, MAX_FILES)(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(413, 'payload_too_large', 'File vượt quá giới hạn 10MB'));
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(new AppError(413, 'too_many_files', 'Quá nhiều file đính kèm'));
      }
      return next(new AppError(400, 'upload_error', err.message));
    }
    next(err);
  });
};
