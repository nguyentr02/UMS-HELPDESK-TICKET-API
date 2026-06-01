import pino, { type LoggerOptions } from 'pino';
import { env } from '../config/env.js';

const usePretty = env.NODE_ENV === 'development';

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  // Redact anything that could leak SSO identity or secrets in production logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-mock-user-id"]',
      'req.headers["x-mock-role"]',
      'req.headers["x-mock-dept-id"]',
      'req.headers.cookie',
      'password',
      '*.password',
      'jobSecret',
    ],
    remove: true,
  },
};

export const logger = pino(
  options,
  usePretty
    ? pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
      })
    : undefined,
);
