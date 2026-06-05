import { like } from 'drizzle-orm';
import { getLogger } from '@intx/log';
import { artifact } from '../db/schema';
import { isGranolaConfigured, getRecentNotesSince, type GranolaNote } from './granola';

const log = getLogger(['api', 'granola-poller']);

// In-memory last-polled timestamps per tenantId.
// Persistence can be added in a later iteration.
const lastPolledAt = new Map<string, Date>();

const POLL_INTERVAL_MS = 60_000;

// Title prefix used to embed the Granola note ID for idempotency.
// Format: "[granola:<noteId>] <human title>"
function noteTitle(note: GranolaNote): string {
  return `[granola:${note.id}] ${note.title}`;
}

// Structural DB type scoped to what the poller actually uses.
// Avoids coupling to the full Interchange DB type, which does not include
// workbench-side tables (artifact).
export type GranolaPollerDB = {
  // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
  insert: (table: any) => { values: (values: any) => { returning: () => Promise<unknown[]> } };
  query: {
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    artifact: { findFirst: (opts: any) => Promise<{ id: string } | undefined> };
  };
};
type AnyDb = GranolaPollerDB;

export function buildCallDocumentMarkdown(note: GranolaNote): string {
  const date = note.created_at.slice(0, 10);
  const lines: string[] = [];

  lines.push(`# Call: ${note.title}`);
  lines.push(`Date: ${date}`);

  if (note.participants && note.participants.length > 0) {
    lines.push(`Attendees: ${note.participants.join(', ')}`);
  }

  lines.push('');
  lines.push('## Summary');
  lines.push(note.summary ?? '_No summary available._');

  lines.push('');
  lines.push('## Pain Points');
  lines.push('_Not yet extracted._');

  lines.push('');
  lines.push('## Key Statistics');
  lines.push('_Not yet extracted._');

  lines.push('');
  lines.push('## Notes');
  lines.push('_Add freeform observations here._');

  return lines.join('\n');
}

// TODO: scope artifacts to tenant when multi-tenant polling is implemented
export async function processGranolaNote(
  db: AnyDb,
  note: GranolaNote
): Promise<void> {
  const title = noteTitle(note);
  const titlePattern = `[granola:${note.id}]%`;

  // Idempotency check: skip if an artifact for this note already exists.
  const existing = await db.query.artifact.findFirst({
    where: like(artifact.title, titlePattern),
  });

  if (existing) {
    log.debug('Granola note already processed, skipping', { noteId: note.id });
    return;
  }

  const content = buildCallDocumentMarkdown(note);

  await db
    .insert(artifact)
    .values({
      sessionId: null,
      workflowId: null,
      parentId: null,
      painPointId: null,
      kind: 'call-document',
      title,
      content,
      status: 'draft',
      version: 1,
    })
    .returning();

  log.info('Created call-document artifact', { noteId: note.id, title: note.title });
}

async function pollOnce(db: AnyDb, tenantId: string): Promise<void> {
  const since = lastPolledAt.get(tenantId) ?? new Date(Date.now() - POLL_INTERVAL_MS);

  let notes: GranolaNote[];
  try {
    notes = await getRecentNotesSince(since);
  } catch (err) {
    log.error('Granola poll failed', {
      tenantId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return;
  }

  lastPolledAt.set(tenantId, new Date());

  for (const note of notes) {
    try {
      await processGranolaNote(db, note);
    } catch (err) {
      log.error('Failed to process Granola note', {
        noteId: note.id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}

export function startGranolaPoller(db: AnyDb, tenantId: string): () => void {
  if (!isGranolaConfigured()) {
    log.info('Granola not configured, poller will not start', { tenantId });
    return () => {};
  }

  log.info('Starting Granola poll loop', { tenantId, intervalMs: POLL_INTERVAL_MS });

  // Run immediately on start, then on interval.
  void pollOnce(db, tenantId);
  const timer = setInterval(() => void pollOnce(db, tenantId), POLL_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    log.info('Granola poller stopped', { tenantId });
  };
}
