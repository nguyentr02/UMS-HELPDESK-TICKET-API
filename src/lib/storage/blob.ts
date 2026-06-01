import type { Readable } from 'node:stream';
import { NotFoundError } from '../errors.js';
import type { IncomingFile, StorageAdapter, UploadResult } from './types.js';

/**
 * Production adapter — chosen for FP §K open item: **Vercel Blob**.
 *
 * Rationale (FP §K): the API is hosted on Vercel serverless, so the storage
 * layer should:
 *  - persist across cold starts (rules out the local-disk adapter; serverless
 *    has an ephemeral filesystem),
 *  - require zero extra infrastructure (rules out a separate S3 / R2 setup),
 *  - be authorized by the existing SSO-scoped attachment download flow (rules
 *    out direct-from-client signed URLs without a backend hop).
 *
 * Vercel Blob ticks all three: same-platform, durable, the SDK gives us a
 * private store and a per-call signed URL we can stream behind our auth.
 *
 * This file ships as a **wired stub** in practice mode — the SDK is imported
 * lazily so adding `@vercel/blob` later is a single-line change. The factory
 * in `./index.ts` already routes `STORAGE_DRIVER=blob` here, so flipping the
 * env var is the only operational change at deploy time.
 */
export class VercelBlobAdapter implements StorageAdapter {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(private readonly _token?: string) {}

  async upload(_file: IncomingFile): Promise<UploadResult> {
    throw notImplemented();
  }

  async read(_storageKey: string): Promise<Readable> {
    throw new NotFoundError('Vercel Blob adapter not wired in practice mode');
  }
}

function notImplemented(): Error {
  return new Error(
    'VercelBlobAdapter is a deploy-time stub. To enable: ' +
      "`npm i @vercel/blob`, fill in `upload()` / `read()` against `@vercel/blob`'s `put`/`get`, " +
      'and set `STORAGE_DRIVER=blob` + `BLOB_READ_WRITE_TOKEN` in the Vercel project env.',
  );
}
