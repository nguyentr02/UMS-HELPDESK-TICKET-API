import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { createId } from '@paralleldrive/cuid2';
import { NotFoundError } from '../errors.js';
import type { IncomingFile, StorageAdapter, UploadResult } from './types.js';

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

export class LocalDiskAdapter implements StorageAdapter {
  async upload(file: IncomingFile): Promise<UploadResult> {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const safe = file.originalname.replace(/[^\w.-]/g, '_');
    const storageKey = `${createId()}-${safe}`;
    await fs.writeFile(path.join(UPLOAD_DIR, storageKey), file.buffer);
    return { storageKey };
  }

  async read(storageKey: string): Promise<Readable> {
    const full = path.join(UPLOAD_DIR, storageKey);
    try {
      await fs.access(full);
    } catch {
      throw new NotFoundError('Tệp không tồn tại');
    }
    return createReadStream(full);
  }
}
