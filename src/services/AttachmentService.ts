import { Readable } from 'node:stream';

import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';
import { assertCanViewTicket } from '../lib/scoping.js';
import { getStorage } from '../lib/storage/index.js';
import type { SessionUser } from '../middleware/auth.js';

/**
 * Stream a stored attachment by its `storageKey`.
 *
 * The FE uploads every file straight to Vercel Blob (see `lib/api/uploads.ts`),
 * so `storageKey` is almost always a public Blob **URL** — which must be fetched
 * as a URL regardless of the BE's configured `STORAGE_DRIVER`. (Delegating to
 * `getStorage().read()` only worked when the driver happened to be `blob`; on a
 * mem/local-configured deploy it looked the URL up as an opaque key and 404'd.)
 * Opaque keys (legacy mem/local uploads) still go through the adapter.
 */
async function readAttachment(storageKey: string): Promise<Readable> {
  if (/^https?:\/\//i.test(storageKey)) {
    const res = await fetch(storageKey);
    if (!res.ok || !res.body) {
      throw new NotFoundError(`Tệp không tồn tại (blob HTTP ${res.status})`);
    }
    return Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
  }
  return getStorage().read(storageKey);
}

export const AttachmentService = {
  async download(id: string, caller: SessionUser) {
    const att = await prisma.attachment.findUnique({
      where: { id },
      include: { ticket: true },
    });
    if (!att) throw new NotFoundError('Không tìm thấy tệp đính kèm');
    assertCanViewTicket(caller, att.ticket);
    const stream = await readAttachment(att.storageKey);
    return {
      stream,
      mimeType: att.mimeType,
      filename: att.filename,
      sizeBytes: att.sizeBytes,
    };
  },
};