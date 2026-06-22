import { del as blobDel, list as blobList } from '@vercel/blob';

import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';

// Don't touch blobs younger than this — a file is uploaded to Blob *before* the
// ticket/comment create that references it, so a fresh unreferenced blob is
// likely mid-flight, not orphaned.
const ORPHAN_GRACE_MS = 60 * 60 * 1000; // 1 h

const PREFIX = 'm31/'; // VercelBlobAdapter writes everything under this prefix

export interface BlobSweepResult {
  skipped: 'not_blob_driver' | 'no_token' | null;
  scanned: number;
  orphansDeleted: number;
}

/** Injectable Blob ops so the sweep is testable without a real Blob store. */
export interface BlobSweepDeps {
  now?: Date;
  list?: typeof blobList;
  del?: typeof blobDel;
}

/**
 * Garbage-collect orphaned Blob objects. The direct-upload flow writes a file to
 * Blob and *then* POSTs the ticket/comment that references it — so if that POST
 * fails (validation, network, user abandons), the blob is left dangling forever
 * (`onUploadCompleted` is a no-op by design). This sweep lists everything under
 * the `m31/` prefix, keeps anything still referenced by an `Attachment` row or
 * uploaded within the grace window, and deletes the rest.
 *
 * Intended to be invoked by Vercel Cron via POST /jobs/blob-sweep.
 */
export async function runBlobSweep(deps: BlobSweepDeps = {}): Promise<BlobSweepResult> {
  if (env.STORAGE_DRIVER !== 'blob') {
    return { skipped: 'not_blob_driver', scanned: 0, orphansDeleted: 0 };
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { skipped: 'no_token', scanned: 0, orphansDeleted: 0 };

  const now = deps.now ?? new Date();
  const list = deps.list ?? blobList;
  const del = deps.del ?? blobDel;

  const { blobs } = await list({ prefix: PREFIX, token });
  if (blobs.length === 0) return { skipped: null, scanned: 0, orphansDeleted: 0 };

  // storageKey holds the Blob URL for blob-driver attachments.
  const referenced = new Set(
    (await prisma.attachment.findMany({ select: { storageKey: true } })).map((a) => a.storageKey),
  );

  let orphansDeleted = 0;
  for (const b of blobs) {
    const ageMs = now.getTime() - new Date(b.uploadedAt).getTime();
    if (ageMs < ORPHAN_GRACE_MS) continue; // too new — likely mid-flight
    if (referenced.has(b.url)) continue; // still referenced — keep
    await del(b.url, { token });
    orphansDeleted += 1;
  }

  return { skipped: null, scanned: blobs.length, orphansDeleted };
}
