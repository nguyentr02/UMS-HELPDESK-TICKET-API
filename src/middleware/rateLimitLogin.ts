import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

/**
 * Slows down brute-force on `POST /auth/login` (FP §I Security). 5 failed attempts
 * per 15-minute window per IP; successful logins don't count. Disabled in test
 * runs (`NODE_ENV=test`) to keep supertest deterministic.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: () => env.NODE_ENV === 'test',
  message: {
    data: null,
    error: { code: 'too_many_attempts', message: 'Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau.' },
    requestId: 'rate-limited',
  },
});
