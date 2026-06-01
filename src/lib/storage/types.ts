import type { Readable } from 'node:stream';

export interface IncomingFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface UploadResult {
  storageKey: string;
}

export interface StorageAdapter {
  upload(file: IncomingFile): Promise<UploadResult>;
  read(storageKey: string): Promise<Readable>;
}

export function kindFromMime(mime: string): 'Image' | 'Document' {
  return mime.startsWith('image/') ? 'Image' : 'Document';
}
