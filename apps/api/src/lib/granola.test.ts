import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { GranolaClient } from './granola';

describe('GranolaClient', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.GRANOLA_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('throws error if API key is missing', () => {
    delete process.env.GRANOLA_API_KEY;
    expect(() => new GranolaClient()).toThrow('GRANOLA_API_KEY is not configured');
  });

  it('fetches recent notes and returns parsed data', async () => {
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

    const client = new GranolaClient();
    const notes = await client.getRecentNotes(2);

    expect(notes).toEqual(mockNotes);
  });

  it('includes transcript parameter when fetching individual notes', async () => {
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

    const client = new GranolaClient();
    const note = await client.getNoteWithTranscript('n1');

    expect(note.transcript).toEqual(mockNote.transcript);
    const calls = fetchMock.mock.calls as unknown as any[][];
    expect(String(calls[0]?.[0]).includes('include=transcript')).toBe(true);
  });

  it('flattens transcript items to plain text', () => {
    const note = {
      id: 'n1',
      title: 'Sales Call',
      created_at: '2026-05-28T10:00:00Z',
      transcript: [
        { speaker: { source: 'microphone' as const }, text: 'We need faster deploys' },
        { speaker: { source: 'speaker' as const }, text: 'Our pipeline takes 40 minutes' },
      ],
    };

    const text = GranolaClient.transcriptToText(note);
    expect(text).toBe('You: We need faster deploys\nThem: Our pipeline takes 40 minutes');
  });

  it('throws when API returns non-200 status', async () => {
    (global as any).fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    );

    const client = new GranolaClient();
    expect(async () => client.getRecentNotes(3)).toThrow();
  });
});
