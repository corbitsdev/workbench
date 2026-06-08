import { describe, expect, it, mock } from 'bun:test';
import { createToolRunner } from '@intx/agent';
import { createGranolaTools, GRANOLA_DEFAULT_BASE_URL } from './index';

describe('createGranolaTools', () => {
  it('falls back to the package default base URL when none is provided', async () => {
    const fetcher = mock(async (input: string) => {
      expect(String(input)).toBe(`${GRANOLA_DEFAULT_BASE_URL}/notes?page_size=10`);
      return new Response(JSON.stringify({ notes: [], hasMore: false }), { status: 200 });
    });

    const runner = createToolRunner(createGranolaTools({ apiKey: 'tenant-api-key', fetcher }));

    const result = await runner.run(
      { id: 'call_1', name: 'granola_list_notes', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns the Granola agent tools', () => {
    const tools = createGranolaTools({
      apiKey: 'tenant-api-key',
      baseUrl: 'https://public-api.granola.ai/v1',
    });

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      'granola_list_notes',
      'granola_get_note',
      'granola_list_folders',
    ]);
  });

  it('lists notes using the page_size query parameter', async () => {
    const fetcher = mock(async (input: string, init: RequestInit) => {
      expect(String(input)).toBe('https://public-api.granola.ai/v1/notes?page_size=2');
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

  it('caps requested list size at the API maximum of 30', async () => {
    const fetcher = mock(async (input: string, _init: RequestInit) => {
      expect(input).toBe('https://public-api.granola.ai/v1/notes?page_size=30');

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

  it('forwards date and folder filters when listing notes', async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v1/notes');
      expect(url.searchParams.get('page_size')).toBe('10');
      expect(url.searchParams.get('created_after')).toBe('2026-01-01');
      expect(url.searchParams.get('created_before')).toBe('2026-02-01T00:00:00Z');
      expect(url.searchParams.get('updated_after')).toBe('2026-01-15');
      expect(url.searchParams.get('folder_id')).toBe('fol_4y6LduVdwSKC27');

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
        id: 'call_filters',
        name: 'granola_list_notes',
        arguments: {
          createdAfter: '2026-01-01',
          createdBefore: '2026-02-01T00:00:00Z',
          updatedAfter: '2026-01-15',
          folderId: 'fol_4y6LduVdwSKC27',
        },
      },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
  });

  it('tolerates notes with a null title', async () => {
    const fetcher = mock(
      async () =>
        new Response(
          JSON.stringify({
            notes: [{ id: 'note_1', title: null, created_at: '2026-05-28T10:00:00Z' }],
            hasMore: false,
          }),
          { status: 200 }
        )
    );

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: 'tenant-api-key',
        baseUrl: 'https://public-api.granola.ai/v1',
        fetcher,
      })
    );

    const result = await runner.run(
      { id: 'call_null_title', name: 'granola_list_notes', arguments: {} },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('"title": null');
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

  it('lists folders using the page_size query parameter', async () => {
    const fetcher = mock(async (input: string, init: RequestInit) => {
      expect(String(input)).toBe('https://public-api.granola.ai/v1/folders?page_size=5');
      expect(init?.headers).toEqual({
        Authorization: 'Bearer tenant-api-key',
        'Content-Type': 'application/json',
      });

      return new Response(
        JSON.stringify({
          folders: [
            {
              id: 'fol_4y6LduVdwSKC27',
              object: 'folder',
              name: 'Sales',
              parent_folder_id: null,
            },
          ],
          hasMore: false,
          cursor: null,
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
        id: 'call_folders',
        name: 'granola_list_folders',
        arguments: { limit: 5 },
      },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('"name": "Sales"');
    expect(result.content).toContain('"parent_folder_id": null');
  });

  it('paginates folders with a cursor', async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v1/folders');
      expect(url.searchParams.get('cursor')).toBe('next-page');

      return new Response(JSON.stringify({ folders: [], hasMore: false, cursor: null }), {
        status: 200,
      });
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
        id: 'call_folders_cursor',
        name: 'granola_list_folders',
        arguments: { cursor: 'next-page' },
      },
      new AbortController().signal
    );

    expect(result.isError).toBeUndefined();
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
