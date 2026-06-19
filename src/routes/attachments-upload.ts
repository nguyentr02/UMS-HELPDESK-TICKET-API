import { Router } from 'express';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { env } from '../config/env.js';
import { ForbiddenError, AppError } from '../lib/errors.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { parseSessionJwt, SESSION_COOKIE } from '../services/AuthService.js';

export const attachmentsUploadRouter = Router();

/**
 * Vercel-Blob client-upload token broker. The browser SDK
 * (`@vercel/blob/client` → `upload()`) negotiates with this endpoint to
 * obtain a short-lived signed token, then uploads the file *directly* to
 * Vercel Blob — bypassing the function-body limit (Hobby plan: 4.5 MB).
 *
 * Auth: we can't use route-level `requireAuth` because Vercel's server→server
 * `upload-completed` callback hits this same endpoint without a cookie. Instead
 * we gate inside `onBeforeGenerateToken` — the browser token request carries
 * the first-party session cookie (via the same-origin proxy), so only an
 * authenticated caller can mint a token; the callback branch is unaffected.
 */
attachmentsUploadRouter.post(
  '/attachments/upload-url',
  asyncHandler(async (req, res) => {
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      throw new AppError(
        500,
        'storage_not_configured',
        'BLOB_READ_WRITE_TOKEN is not set on the project',
      );
    }

    const body = req.body as HandleUploadBody;
    // handleUpload wants a Web Request to derive its callback URL.
    const host = req.get('host') ?? `localhost:${env.PORT}`;
    const proto = req.get('x-forwarded-proto') ?? 'https';
    const url = `${proto}://${host}${req.originalUrl}`;
    const fakeRequest = new Request(url, { method: 'POST' });

    try {
      const json = await handleUpload({
        body,
        request: fakeRequest,
        token: blobToken,
        onBeforeGenerateToken: async () => {
          // Auth gate: only an authenticated session may mint an upload token.
          // This branch runs ONLY for the browser-initiated token request,
          // which carries the first-party session cookie via the same-origin
          // proxy — the Vercel `upload-completed` callback (server→server, no
          // cookie) takes the other branch in handleUpload, so it's unaffected.
          const token = (req as typeof req & { cookies?: Record<string, string> }).cookies?.[
            SESSION_COOKIE
          ];
          try {
            if (!token) throw new Error('no session');
            parseSessionJwt(token); // throws on missing/invalid/expired
          } catch {
            throw new ForbiddenError('Yêu cầu xác thực để tải lên');
          }
          return {
            // Mirror multer's caps. The Blob SDK enforces these client-side
            // before any bytes leave the browser.
            allowedContentTypes: undefined, // any
            maximumSizeInBytes: 10 * 1024 * 1024,
            // Let Vercel append a random tag so duplicate filenames don't
            // collide (two uploads of the same screenshot.png both succeed
            // as screenshot-AbCd1.png / screenshot-XyZ45.png). Count + size
            // caps are still enforced — uniqueness is just removed.
            addRandomSuffix: true,
          };
        },
        onUploadCompleted: async () => {
          /* no-op — the FE follows up with POST /tickets carrying the URL */
        },
      });
      res.json(json);
    } catch (err) {
      // Surface as a clean envelope; otherwise handleUpload throws 400-ish errors
      // straight out.
      const message = err instanceof Error ? err.message : 'Lỗi cấp token tải lên';
      throw new ForbiddenError(message);
    }
  }),
);
