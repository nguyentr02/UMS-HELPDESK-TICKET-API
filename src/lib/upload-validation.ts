import { AppError } from './errors.js';

export interface IncomingFileLike {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

type Family = 'image' | 'pdf' | 'ooxml' | 'ole';

/**
 * Declared MIME → the content family its magic bytes must be in. This doubles
 * as the upload **allowlist**: any MIME not listed is rejected outright.
 * (images: jpg/png/gif/webp · docs: pdf/doc/docx/xls/xlsx)
 */
const ALLOWED: Record<string, Family> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'ooxml', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'ooxml', // .xlsx
  'application/msword': 'ole', // .doc
  'application/vnd.ms-excel': 'ole', // .xls
};

/** Detect the content family from the leading "magic" bytes (defeats a spoofed Content-Type). */
function sniffFamily(b: Buffer): Family | 'unknown' {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image'; // JPEG
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  )
    return 'image'; // PNG
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image'; // GIF8
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP')
    return 'image'; // WEBP
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf'; // %PDF
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07))
    return 'ooxml'; // PK — zip/OOXML (docx/xlsx)
  if (
    b.length >= 8 &&
    b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
    b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1
  )
    return 'ole'; // OLE2 — legacy doc/xls
  return 'unknown';
}

// ── Virus-scan hook ─────────────────────────────────────────────────────────
export interface ScanResult {
  clean: boolean;
  reason?: string;
}
export interface VirusScanner {
  scan(file: IncomingFileLike): Promise<ScanResult>;
}

/** Default pass-through scanner — the integration point. Swap a real one
 *  (ClamAV / VirusTotal / cloud AV) via `setVirusScanner` at boot. */
class NoopScanner implements VirusScanner {
  async scan(): Promise<ScanResult> {
    return { clean: true };
  }
}
let scanner: VirusScanner = new NoopScanner();
export function setVirusScanner(s: VirusScanner): void {
  scanner = s;
}
export function getVirusScanner(): VirusScanner {
  return scanner;
}

/**
 * Validate one uploaded file before it's stored:
 *   1. declared MIME is in the allowlist,
 *   2. the actual magic bytes match that family (defeats a spoofed
 *      Content-Type — e.g. an `.exe` sent as `image/png`),
 *   3. the virus-scan hook passes.
 * Throws `AppError` on any failure.
 *
 * Scope: the **multer (function-body)** upload path only — large files uploaded
 * straight to Vercel Blob never reach the BE, so those rely on the size cap +
 * the authenticated upload-url broker instead.
 */
export async function validateUploadedFile(file: IncomingFileLike): Promise<void> {
  const expected = ALLOWED[file.mimetype];
  if (!expected) {
    throw new AppError(415, 'unsupported_file_type', `Loại tệp "${file.mimetype}" không được hỗ trợ`);
  }
  if (sniffFamily(file.buffer) !== expected) {
    throw new AppError(
      415,
      'file_content_mismatch',
      `Nội dung tệp "${file.originalname}" không khớp loại đã khai báo`,
    );
  }
  const result = await getVirusScanner().scan(file);
  if (!result.clean) {
    throw new AppError(
      400,
      'file_rejected',
      `Tệp "${file.originalname}" bị từ chối: ${result.reason ?? 'nghi ngờ mã độc'}`,
    );
  }
}

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — same cap as the multer path

export interface BlobAttachmentMeta {
  url: string;
  filename: string;
  mimeType: string;
}

/**
 * Validate a direct-to-Blob upload the BE never buffered. The bytes live in
 * Blob, so we range-fetch just the header (16 bytes) and run the same allowlist
 * + magic-byte checks as the multer path, and verify the REAL size from
 * Content-Range/Length (the client-declared `sizeBytes` is untrusted). Full
 * virus scanning needs the whole file; the hook is a no-op by default, so we
 * skip it here — the content sniff is the meaningful gain.
 *
 * Throws `AppError` on any failure.
 */
export async function validateBlobAttachment(a: BlobAttachmentMeta): Promise<void> {
  const expected = ALLOWED[a.mimeType];
  if (!expected) {
    throw new AppError(415, 'unsupported_file_type', `Loại tệp "${a.mimeType}" không được hỗ trợ`);
  }

  let res: Response;
  try {
    res = await fetch(a.url, { headers: { Range: 'bytes=0-15' } });
  } catch {
    throw new AppError(400, 'attachment_unreadable', `Không đọc được tệp "${a.filename}"`);
  }
  if (!res.ok && res.status !== 206) {
    throw new AppError(400, 'attachment_unreadable', `Không đọc được tệp "${a.filename}"`);
  }

  // "bytes 0-15/12345" → 12345 is the true total size.
  const range = res.headers.get('content-range');
  const total = range
    ? Number(range.split('/')[1])
    : Number(res.headers.get('content-length') ?? 0);
  if (Number.isFinite(total) && total > MAX_BYTES) {
    throw new AppError(413, 'payload_too_large', `Tệp "${a.filename}" vượt quá giới hạn 10MB`);
  }

  const header = Buffer.from(await res.arrayBuffer());
  if (sniffFamily(header) !== expected) {
    throw new AppError(
      415,
      'file_content_mismatch',
      `Nội dung tệp "${a.filename}" không khớp loại đã khai báo`,
    );
  }
}