import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

// All mock.module calls must come before any import of the module under test.

mock.module('@intx/log', () => ({
  getLogger: () => ({
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: () => {},
  }),
}));

mock.module('drizzle-orm', () => ({
  like: (_col: unknown, _pattern: unknown) => 'like-expression',
}));

// granola.ts calls loadConfig() only inside function bodies, so the module loads
// safely without env vars. The functions tested here (processGranolaNote,
// buildCallDocumentMarkdown) do not call any granola API functions, so no mock
// is required for ./granola.

mock.module('../config', () => ({
  loadConfig: () => ({
    granola: { apiKey: '', baseUrl: 'https://public-api.granola.ai/v1' },
  }),
}));

import type { GranolaNote } from './granola';
import { processGranolaNote, buildCallDocumentMarkdown } from './granola-poller';

afterAll(() => {
  mock.restore();
});

// ─── DB mock helpers ─────────────────────────────────────────────────────────

const insertedArtifacts: Record<string, unknown>[] = [];
let returnExisting = false;

const mockDb = {
  insert: mock(() => ({
    values: mock((values: Record<string, unknown>) => {
      insertedArtifacts.push(values);
      return { returning: mock(() => Promise.resolve([{ id: 'new-id' }])) };
    }),
  })),
  query: {
    artifact: {
      findFirst: mock(() =>
        Promise.resolve(
          returnExisting ? { id: 'existing-id', title: '[granola:note-abc] ...' } : undefined
        )
      ),
    },
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildCallDocumentMarkdown', () => {
  it('produces the expected sections', () => {
    const note: GranolaNote = {
      id: 'note-1',
      title: 'Acme Corp Discovery',
      created_at: '2026-06-04T10:00:00Z',
      participants: ['Alice', 'Bob'],
      summary: 'Strong discovery call.',
    };
    const md = buildCallDocumentMarkdown(note);
    expect(md).toContain('# Call: Acme Corp Discovery');
    expect(md).toContain('Date: 2026-06-04');
    expect(md).toContain('Attendees: Alice, Bob');
    expect(md).toContain('## Summary');
    expect(md).toContain('Strong discovery call.');
  });

  it('handles missing optional fields gracefully', () => {
    const note: GranolaNote = {
      id: 'note-2',
      title: 'Quick Sync',
      created_at: '2026-06-04T09:00:00Z',
    };
    const md = buildCallDocumentMarkdown(note);
    expect(md).toContain('# Call: Quick Sync');
    expect(md).toContain('Date: 2026-06-04');
    expect(md).not.toContain('Attendees:');
  });
});

describe('processGranolaNote', () => {
  beforeEach(() => {
    insertedArtifacts.length = 0;
    returnExisting = false;
    mockDb.insert.mockClear();
    mockDb.query.artifact.findFirst.mockClear();
  });

  it('creates a call-document artifact for a new note', async () => {
    returnExisting = false;
    const note: GranolaNote = {
      id: 'note-abc',
      title: 'Customer Call',
      created_at: '2026-06-04T10:00:00Z',
      participants: ['Carol'],
      summary: 'Very productive.',
    };

    await processGranolaNote(mockDb as any, note);

    expect(insertedArtifacts.length).toBe(1);
    const inserted = insertedArtifacts[0];
    expect(inserted).toMatchObject({
      kind: 'call-document',
      status: 'draft',
      version: 1,
      sessionId: null,
      workflowId: null,
    });
    expect(String(inserted?.title)).toContain('[granola:note-abc]');
    expect(String(inserted?.title)).toContain('Customer Call');
    expect(String(inserted?.content)).toContain('# Call: Customer Call');
  });

  it('is idempotent — second call with same noteId does not create a duplicate', async () => {
    returnExisting = true;
    const note: GranolaNote = {
      id: 'note-abc',
      title: 'Customer Call',
      created_at: '2026-06-04T10:00:00Z',
    };

    await processGranolaNote(mockDb as any, note);

    expect(insertedArtifacts.length).toBe(0);
  });
});
