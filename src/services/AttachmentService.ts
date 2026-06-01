import { prisma } from '../lib/prisma.js';
import { NotFoundError } from '../lib/errors.js';
import { assertCanViewTicket } from '../lib/scoping.js';
import { getStorage } from '../lib/storage/index.js';
import type { SessionUser } from '../middleware/auth.js';

export const AttachmentService = {
  async download(id: string, caller: SessionUser) {
    const att = await prisma.attachment.findUnique({
      where: { id },
      include: { ticket: true },
    });
    if (!att) throw new NotFoundError('Không tìm thấy tệp đính kèm');
    assertCanViewTicket(caller, att.ticket);
    const stream = await getStorage().read(att.storageKey);
    return {
      stream,
      mimeType: att.mimeType,
      filename: att.filename,
      sizeBytes: att.sizeBytes,
    };
  },
};
