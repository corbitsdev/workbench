import { Hono } from 'hono';
import { getLogger } from '@intx/log';
import type { HubDb } from '../db';
import { upload } from '../db/schema';
import { getUserContext } from '../services/workflow-orchestration';

const log = getLogger(['api', 'uploads']);

// Files arrive before the workflow run that consumes them, so they are stored in
// the upload table (BYTEA) rather than as artifacts. 10MB comfortably covers a
// product-catalog xlsx; larger inputs are out of scope (object storage, CL docs).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Only spreadsheet uploads are accepted today. Validate at the boundary (not in
// the xlsx parser) so a PDF/ZIP/HTML payload is rejected with a clear message
// instead of an opaque ExcelJS error — and a crafted content-type can't slip
// past on its own. Accept the canonical xlsx MIME or the .xlsx extension.
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function isAcceptedUpload(file: File): boolean {
  if (file.type === XLSX_MIME) return true;
  return file.name.toLowerCase().endsWith('.xlsx');
}

export function createUploadsRouter(db: HubDb): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  router.post('/uploads', async (c) => {
    const userId = c.get('userId');

    const userContext = await getUserContext(db, userId);
    if (!userContext) return c.json({ error: 'User context not found' }, 403);

    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) {
      return c.json({ error: 'Expected a single file field named "file"' }, 400);
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: `File exceeds the ${MAX_UPLOAD_BYTES} byte limit` }, 413);
    }

    if (!isAcceptedUpload(file)) {
      return c.json({ error: 'Only .xlsx spreadsheet uploads are supported' }, 415);
    }

    const content = Buffer.from(await file.arrayBuffer());

    const [row] = await db
      .insert(upload)
      .values({
        tenantId: userContext.tenantId,
        principalId: userContext.principalId,
        filename: file.name,
        mimeType: file.type,
        content,
        size: file.size,
      })
      .returning();

    if (!row) {
      log.error('Upload insert returned no row', { userId });
      return c.json({ error: 'Failed to store upload' }, 500);
    }

    return c.json(
      { uploadId: row.id, filename: file.name, mimeType: file.type, size: file.size },
      201
    );
  });

  return router;
}
