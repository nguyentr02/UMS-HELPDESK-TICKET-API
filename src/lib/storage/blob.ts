import { Readable } from 'node:stream';
import { put as blobPut } from '@vercel/blob';
import { createId } from '@paralleldrive/cuid2';
import { NotFoundError } from '../errors.js';
import type { IncomingFile, StorageAdapter, UploadResult } from './types.js';

/**
 * Production storage adapter — Vercel Blob (FP §K).
 *
 * Why Vercel Blob:
 *  - Same platform as the API, no cross-cloud auth dance.
 *  - Durable across cold starts (rules out MemoryAdapter for prod).
 *  - Lambda filesystem is read-only at /var/task, so LocalDiskAdapter is
 *    also out of the question.
 *
 * Upload path:
 *  1. Multer parses the multipart body in memory (≤10 MB / file).
 *  2. `blobPut(...)` writes the buffer to the blob store, returns a URL.
 *  3. We persist the returned URL as the Attachment.storageKey so we can
 *     fetch it back later.
 *
 * Download path:
 *  - `read(storageKey)` server-side-fetches the blob URL and converts the
 *    Web ReadableStream to a Node Readable so Express can `.pipe(res)`.
 *  - Auth is enforced ABOVE this layer (AttachmentService → assertCanViewTicket).
 *    Blob URLs are unguessable and the access mode is `public` only in the
 *    URL sense — the BE still gates who can ask for them.
 *
 * Env:
 *  - STORAGE_DRIVER=blob
 *  - BLOB_READ_WRITE_TOKEN (Vercel injects when the Blob storage is connected
 *    to the project; the adapter throws a clear error if missing).
 */
export class VercelBlobAdapter implements StorageAdapter {
  constructor(private readonly token?: string) {}

  async upload(file: IncomingFile): Promise<UploadResult> {
    if (!this.token) {
      throw new Error(
        'VercelBlobAdapter: BLOB_READ_WRITE_TOKEN is not set. Connect a Blob store to the Vercel project and re-deploy.',
      );
    }
    const safe = file.originalname.replace(/[^\w.-]/g, '_');
    const pathname = `m31/${createId()}-${safe}`;
    const { url } = await blobPut(pathname, file.buffer, {
      access: 'public',
      token: this.token,
      contentType: file.mimetype,
      // Don't auto-suffix the pathname — our cuid prefix already guarantees uniqueness.
      addRandomSuffix: false,
    });
    return { storageKey: url };
  }

  async read(storageKey: string): Promise<Readable> {
    const res = await fetch(storageKey);
    if (!res.ok || !res.body) {
      throw new NotFoundError('Tệp không tồn tại');
    }
    // Web ReadableStream → Node Readable so Express's `.pipe(res)` works.
    return Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
  }
}
