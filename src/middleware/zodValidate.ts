import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { ValidationError } from '../lib/errors';

type Target = 'body' | 'query' | 'params';

/** Per-route Zod validator. Parsed result replaces the original input. */
export function zodValidate(schema: ZodSchema, target: Target = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.length > 0 ? String(issue.path[0]) : '_';
        if (!(path in fields)) fields[path] = issue.message;
      }
      return next(new ValidationError(fields));
    }
    (req as unknown as Record<string, unknown>)[target] = result.data;
    next();
  };
}
