import { Router } from 'express';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { env } from '../config/env.js';
import { ForbiddenError, AppError } from '../lib/errors.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const attachmentsUploadRouter = Router();

/**
 * Vercel-Blob client-upload token broker. The browser SDK
 * (`@vercel/blob/client` → `upload()`) negotiates with this endpoint to
 * obtain a short-lived signed token, then uploads the file *directly* to
 * Vercel Blob — bypassing the function-body limit (Hobby plan: 4.5 MB).
 *
 * Auth note: the browser SDK does **not** forward our X-Mock-* SSO headers
 * when it hits this endpoint, so we can't gate with `requireAuth`. Practice-
 * mode trade-off — the worst case is someone burning a tiny bit of our Blob
 * quota. With real SSO we'd validate a session cookie here instead.
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
        onBeforeGenerateToken: async () => ({
          // Mirror multer's caps. The Blob SDK enforces these client-side
          // before any bytes leave the browser.
          allowedContentTypes: undefined, // any
          maximumSizeInBytes: 10 * 1024 * 1024,
          addRandomSuffix: false,
        }),
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
