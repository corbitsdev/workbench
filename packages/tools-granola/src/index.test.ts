import { describe, expect, it, mock } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import { createGranolaTools } from './index';

describe('createGranolaTools', () => {
  it('returns only the Granola agent tools', () => {
    const tools = createGranolaTools({
      apiKey: 'tenant-api-key',
      baseUrl: 'https://public-api.granola.ai/v1',
    });

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      'granola_list_notes',
      'granola_get_note',
    ]);
  });

  it('lists notes using tenant-provided Granola config', async () => {
    const fetcher = mock(async (input: string, init: RequestInit) => {
      expect(String(input)).toBe('https://public-api.granola.ai/v1/notes?limit=2');
      expect(init?.headers).toEqual({
        Authorization: 'Bearer tenant-api-key',
        'Content-Type': 'application/json',
      });

      return new Response(
        JSON.stringify({
          notes: [
            {
              id: 'note_1',
              title: 'Sales Call',
              created_at: '2026-05-28T10:00:00Z',
              participants: ['Ada'],
            },
          ],
          hasMore: false,
        }),
        { status: 200 }
      );
    });

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: 'tenant-api-key',
        baseUrl: 'https://public-api.granola.ai/v1',
        fetcher,
      })
    );

    const result = await runner.run(
      {
        id: 'call_1',
        name: 'granola_list_notes',
        arguments: { limit: 2 },
      },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      JSON.stringify(
        {
          notes: [
            {
              id: 'note_1',
              title: 'Sales Call',
              created_at: '2026-05-28T10:00:00Z',
              participants: ['Ada'],
            },
          ],
          hasMore: false,
        },
        null,
        2
      )
    );
  });

  it('caps requested list size', async () => {
    const fetcher = mock(async (input: string, _init: RequestInit) => {
      expect(input).toBe('https://public-api.granola.ai/v1/notes?limit=50');

      return new Response(JSON.stringify({ notes: [], hasMore: false }), { status: 200 });
    });

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: 'tenant-api-key',
        baseUrl: 'https://public-api.granola.ai/v1',
        fetcher,
      })
    );

    const result = await runner.run(
      {
        id: 'call_capped',
        name: 'granola_list_notes',
        arguments: { limit: 10_000 },
      },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('"notes": []');
  });

  it('gets a note transcript by id', async () => {
    const fetcher = mock(async (input: string, init: RequestInit) => {
      expect(String(input)).toBe(
        'https://public-api.granola.ai/v1/notes/note_1?include=transcript'
      );
      expect(init?.headers).toEqual({
        Authorization: 'Bearer tenant-api-key',
        'Content-Type': 'application/json',
      });

      return new Response(
        JSON.stringify({
          id: 'note_1',
          title: 'Sales Call',
          created_at: '2026-05-28T10:00:00Z',
          transcript: [
            {
              speaker: { source: 'microphone', diarization_label: 'Ada' },
              text: 'We need the call notes.',
            },
          ],
        }),
        { status: 200 }
      );
    });

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: 'tenant-api-key',
        baseUrl: 'https://public-api.granola.ai/v1',
        fetcher,
      })
    );

    const result = await runner.run(
      {
        id: 'call_2',
        name: 'granola_get_note',
        arguments: { noteId: 'note_1' },
      },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('"transcript"');
    expect(result.content).toContain('We need the call notes.');
  });

  it('surfaces Granola API failures as tool errors', async () => {
    const fetcher = mock(
      async (_input: string, _init: RequestInit) =>
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    );

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: 'tenant-api-key',
        baseUrl: 'https://public-api.granola.ai/v1',
        fetcher,
      })
    );

    const result = await runner.run(
      {
        id: 'call_3',
        name: 'granola_list_notes',
        arguments: {},
      },
      new AbortController().signal
    );

    expect(result).toEqual({
      callId: 'call_3',
      content: 'Granola API error: 401 Unauthorized',
      isError: true,
    });
  });

  it('requires non-empty Granola config', () => {
    expect(() =>
      createGranolaTools({
        apiKey: '',
        baseUrl: 'https://public-api.granola.ai/v1',
      })
    ).toThrow('Granola apiKey is required');

    expect(() =>
      createGranolaTools({
        apiKey: 'tenant-api-key',
        baseUrl: 'not a url',
      })
    ).toThrow('Granola baseUrl must be a valid URL');
  });
});
