import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

const mockConfig = {
  granola: { apiKey: 'test-api-key', baseUrl: 'https://public-api.granola.ai/v1' },
};

mock.module('../config', () => ({
  loadConfig: () => mockConfig,
}));

import {
  isGranolaConfigured,
  getRecentNotes,
  getNoteWithTranscript,
  transcriptToText,
} from './granola';

describe('granola', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    (global as any).fetch = originalFetch;
    mockConfig.granola.apiKey = 'test-api-key';
  });

  it('isGranolaConfigured returns false when apiKey is absent', () => {
    mockConfig.granola.apiKey = '';
    expect(isGranolaConfigured()).toBe(false);
  });

  it('isGranolaConfigured returns true when apiKey is present', () => {
    expect(isGranolaConfigured()).toBe(true);
  });

  it('getRecentNotes returns parsed notes', async () => {
    const mockNotes = [
      {
        id: 'n1',
        title: 'Sales Call',
        created_at: '2026-05-28T10:00:00Z',
        participants: ['Alice'],
      },
      { id: 'n2', title: 'Team Sync', created_at: '2026-05-28T09:00:00Z', participants: ['Bob'] },
    ];

    (global as any).fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ notes: mockNotes, hasMore: false }), { status: 200 })
      )
    );

    const notes = await getRecentNotes(2);
    expect(notes).toEqual(mockNotes);
  });

  it('getNoteWithTranscript includes transcript param', async () => {
    const mockNote = {
      id: 'n1',
      title: 'Sales Call',
      created_at: '2026-05-28T10:00:00Z',
      transcript: [
        { speaker: { source: 'microphone' as const }, text: 'Hello there' },
        { speaker: { source: 'speaker' as const }, text: 'Hi back' },
      ],
    };

    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockNote), { status: 200 }))
    );
    (global as any).fetch = fetchMock;

    const note = await getNoteWithTranscript('n1');
    expect(note.transcript).toEqual(mockNote.transcript);
    const calls = fetchMock.mock.calls as unknown as any[][];
    expect(String(calls[0]?.[0]).includes('include=transcript')).toBe(true);
  });

  it('transcriptToText flattens items to plain text', () => {
    const note = {
      id: 'n1',
      title: 'Sales Call',
      created_at: '2026-05-28T10:00:00Z',
      transcript: [
        { speaker: { source: 'microphone' as const }, text: 'We need faster deploys' },
        { speaker: { source: 'speaker' as const }, text: 'Our pipeline takes 40 minutes' },
      ],
    };

    expect(transcriptToText(note)).toBe(
      'You: We need faster deploys\nThem: Our pipeline takes 40 minutes'
    );
  });

  it('getRecentNotes throws on non-200 response', async () => {
    (global as any).fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    );

    expect(async () => getRecentNotes(3)).toThrow();
  });
});
