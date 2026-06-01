import { env } from '../../config/env';
import { LocalDiskAdapter } from './local';
import { MemoryAdapter } from './memory';
import { VercelBlobAdapter } from './blob';
import type { StorageAdapter } from './types';

export type { IncomingFile, StorageAdapter, UploadResult } from './types';
export { kindFromMime } from './types';

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
