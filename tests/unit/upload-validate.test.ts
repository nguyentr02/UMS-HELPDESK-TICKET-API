import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '../../src/lib/errors.js';
import {
  setVirusScanner,
  validateUploadedFile,
  type IncomingFileLike,
} from '../../src/lib/upload-validation.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PDF = Buffer.from('%PDF-1.7\n…');
const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]); // docx/xlsx (zip)
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]); // doc/xls
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // "MZ" — Windows executable

const file = (over: Partial<IncomingFileLike>): IncomingFileLike => ({
  originalname: 'f',
  mimetype: 'image/png',
  buffer: PNG,
  size: 10,
  ...over,
});

describe('validateUploadedFile — magic-byte sniff + allowlist', () => {
  afterEach(() => setVirusScanner({ async scan() { return { clean: true }; } }));

  it('accepts matching content (png/jpeg/pdf/docx/doc)', async () => {
    await expect(validateUploadedFile(file({ mimetype: 'image/png', buffer: PNG }))).resolves.toBeUndefined();
    await expect(validateUploadedFile(file({ mimetype: 'image/jpeg', buffer: JPEG }))).resolves.toBeUndefined();
    await expect(validateUploadedFile(file({ mimetype: 'application/pdf', buffer: PDF }))).resolves.toBeUndefined();
    await expect(
      validateUploadedFile(
        file({ mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: PK }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateUploadedFile(file({ mimetype: 'application/msword', buffer: OLE })),
    ).resolves.toBeUndefined();
  });

  it('rejects a disallowed declared MIME (415 unsupported_file_type)', async () => {
    await expect(validateUploadedFile(file({ mimetype: 'text/html', buffer: PNG }))).rejects.toMatchObject({
      status: 415,
      code: 'unsupported_file_type',
    });
  });

  it('rejects spoofed Content-Type — exe bytes declared as image/png (415 file_content_mismatch)', async () => {
    await expect(
      validateUploadedFile(file({ mimetype: 'image/png', buffer: EXE })),
    ).rejects.toMatchObject({ status: 415, code: 'file_content_mismatch' });
  });

  it('rejects when the virus-scan hook reports infected (400 file_rejected)', async () => {
    setVirusScanner({ async scan() { return { clean: false, reason: 'EICAR' }; } });
    await expect(validateUploadedFile(file({ mimetype: 'image/png', buffer: PNG }))).rejects.toBeInstanceOf(AppError);
    await expect(validateUploadedFile(file({ mimetype: 'image/png', buffer: PNG }))).rejects.toMatchObject({
      status: 400,
      code: 'file_rejected',
    });
  });
});