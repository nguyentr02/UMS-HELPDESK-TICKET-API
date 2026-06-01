import { prisma } from '../lib/prisma';
import { NotFoundError } from '../lib/errors';
import { assertCanViewTicket } from '../lib/scoping';
import { getStorage } from '../lib/storage';
import type { SessionUser } from '../middleware/auth';

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
