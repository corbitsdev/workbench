import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { GranolaClient } from './granola';

describe('GranolaClient', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.GRANOLA_API_KEY = 'test-api-key';
    process.env.GRANOLA_API_URL = 'https://api.granola.ai';
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('throws error if API key is missing', () => {
    delete process.env.GRANOLA_API_KEY;
    expect(() => new GranolaClient()).toThrow('GRANOLA_API_KEY is not configured');
  });

  it('throws error if API URL is missing', () => {
    delete process.env.GRANOLA_API_URL;
    expect(() => new GranolaClient()).toThrow('GRANOLA_API_URL is not configured');
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
      Promise.resolve(new Response(JSON.stringify({ data: mockNotes }), { status: 200 }))
    );

    const client = new GranolaClient();
    const notes = await client.getRecentNotes(2);

    expect(notes).toEqual(mockNotes);
  });

  it('includes transcript parameter when fetching individual notes', async () => {
    const mockNote = {
      id: 'n1',
      title: 'Sales Call',
      transcript: 'Speaker 1: Hello',
      created_at: '2026-05-28T10:00:00Z',
    };

    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ data: mockNote }), { status: 200 }))
    );
    (global as any).fetch = fetchMock;

    const client = new GranolaClient();
    const note = await client.getNoteWithTranscript('n1');

    expect(note.transcript).toBe('Speaker 1: Hello');
    const calls = fetchMock.mock.calls as unknown as any[][];
    expect(String(calls[0]?.[0]).includes('include=transcript')).toBe(true);
  });

  it('throws when API returns non-200 status', async () => {
    (global as any).fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    );

    const client = new GranolaClient();
    expect(async () => client.getRecentNotes(3)).toThrow();
  });
});
