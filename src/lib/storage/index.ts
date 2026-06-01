import { env } from '../../config/env.js';
import { LocalDiskAdapter } from './local.js';
import { MemoryAdapter } from './memory.js';
import { VercelBlobAdapter } from './blob.js';
import type { StorageAdapter } from './types.js';

export type { IncomingFile, StorageAdapter, UploadResult } from './types.js';
export { kindFromMime } from './types.js';

let cached: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (cached) return cached;
  switch (env.STORAGE_DRIVER) {
    case 'memory':
      cached = new MemoryAdapter();
      break;
    case 'local':
      cached = new LocalDiskAdapter();
      break;
    case 'blob':
      // Prod adapter (FP §K). The token comes from the Vercel project env at
      // deploy time; the stub will throw on first call until @vercel/blob is
      // installed and `upload`/`read` are filled in (see blob.ts).
      cached = new VercelBlobAdapter(process.env.BLOB_READ_WRITE_TOKEN);
      break;
    default:
      throw new Error(`Storage driver "${env.STORAGE_DRIVER}" not implemented.`);
  }
  return cached;
}
