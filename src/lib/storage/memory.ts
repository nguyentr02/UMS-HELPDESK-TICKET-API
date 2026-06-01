import { Readable } from 'node:stream';
import { createId } from '@paralleldrive/cuid2';
import { NotFoundError } from '../errors';
import type { IncomingFile, StorageAdapter, UploadResult } from './types';

const store = new Map<string, Buffer>();

export class MemoryAdapter implements StorageAdapter {
  async upload(file: IncomingFile): Promise<UploadResult> {
    const storageKey = `mem:${createId()}`;
    store.set(storageKey, file.buffer);
    return { storageKey };
  }

  async read(storageKey: string): Promise<Readable> {
    const buf = store.get(storageKey);
    if (!buf) throw new NotFoundError('Tệp không tồn tại');
    return Readable.from(buf);
  }
}
