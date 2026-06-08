import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';

const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 30;

/**
 * Granola's public API base URL. Owned by the tool package so callers only
 * need to supply an API key — the base URL is pulled in here rather than
 * stored per credential. Override is still possible via `baseUrl`.
 */
export const GRANOLA_DEFAULT_BASE_URL = 'https://public-api.granola.ai/v1';

export type GranolaFetch = (input: string, init: RequestInit) => Promise<Response>;

export type GranolaToolsConfig = {
  apiKey: string;
  /** Defaults to {@link GRANOLA_DEFAULT_BASE_URL} when omitted or empty. */
  baseUrl?: string;
  fetcher?: GranolaFetch;
};

/** Internal config with the base URL resolved to a concrete value. */
type ResolvedGranolaConfig = {
  apiKey: string;
  baseUrl: string;
  fetcher?: GranolaFetch;
};

type GranolaTranscriptItem = {
  speaker: {
    source: 'microphone' | 'speaker';
    diarization_label?: string;
  };
  text: string;
};

type GranolaNote = {
  id: string;
  title: string | null;
  created_at: string;
  participants?: string[];
  summary?: string;
  transcript?: GranolaTranscriptItem[];
};

type GranolaListResponse = {
  notes: GranolaNote[];
  hasMore: boolean;
  cursor?: string;
};

type GranolaFolder = {
  id: string;
  name: string;
  parent_folder_id: string | null;
};

type GranolaFolderListResponse = {
  folders: GranolaFolder[];
  hasMore: boolean;
  cursor?: string;
};

function granolaHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalPositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requiredResponseString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`Granola response missing ${key}`);
  }
  return value;
}

function optionalStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return null;
  }
  return value;
}

function parseTranscriptItem(value: unknown): GranolaTranscriptItem {
  if (!isRecord(value) || !isRecord(value.speaker) || typeof value.text !== 'string') {
    throw new Error('Granola response contains an invalid transcript item');
  }

  const source = value.speaker.source;
  if (source !== 'microphone' && source !== 'speaker') {
    throw new Error('Granola response contains an invalid transcript speaker');
  }

  const diarizationLabel = optionalString(value.speaker.diarization_label);

  return {
    speaker: {
      source,
      ...(diarizationLabel !== null ? { diarization_label: diarizationLabel } : {}),
    },
    text: value.text,
  };
}

function parseNote(value: unknown): GranolaNote {
  if (!isRecord(value)) {
    throw new Error('Granola response contains an invalid note');
  }

  const participants = optionalStringArray(value.participants);
  const summary = optionalString(value.summary);
  const transcript = Array.isArray(value.transcript)
    ? value.transcript.map(parseTranscriptItem)
    : null;

  return {
    id: requiredResponseString(value, 'id'),
    title: optionalString(value.title),
    created_at: requiredResponseString(value, 'created_at'),
    ...(participants !== null ? { participants } : {}),
    ...(summary !== null ? { summary } : {}),
    ...(transcript !== null ? { transcript } : {}),
  };
}

function parseFolder(value: unknown): GranolaFolder {
  if (!isRecord(value)) {
    throw new Error('Granola response contains an invalid folder');
  }

  const parentFolderId = optionalString(value.parent_folder_id);

  return {
    id: requiredResponseString(value, 'id'),
    name: requiredResponseString(value, 'name'),
    parent_folder_id: parentFolderId,
  };
}

function parseFolderListResponse(value: unknown): GranolaFolderListResponse {
  if (!isRecord(value) || !Array.isArray(value.folders) || typeof value.hasMore !== 'boolean') {
    throw new Error('Granola response contains an invalid folders list');
  }

  const cursor = optionalString(value.cursor);

  return {
    folders: value.folders.map(parseFolder),
    hasMore: value.hasMore,
    ...(cursor !== null ? { cursor } : {}),
  };
}

function parseListResponse(value: unknown): GranolaListResponse {
  if (!isRecord(value) || !Array.isArray(value.notes) || typeof value.hasMore !== 'boolean') {
    throw new Error('Granola response contains an invalid notes list');
  }

  const cursor = optionalString(value.cursor);

  return {
    notes: value.notes.map(parseNote),
    hasMore: value.hasMore,
    ...(cursor !== null ? { cursor } : {}),
  };
}

function validateConfig(config: ResolvedGranolaConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error('Granola apiKey is required');
  }

  try {
    new URL(config.baseUrl);
  } catch {
    throw new Error('Granola baseUrl must be a valid URL');
  }
}

function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    return text;
  }

  return text;
}

async function fetchGranolaJSON(config: ResolvedGranolaConfig, url: URL, signal: AbortSignal) {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    headers: granolaHeaders(config.apiKey),
    signal,
  } satisfies RequestInit);

  if (!response.ok) {
    const body = errorMessageFromBody(await response.text().catch(() => ''));
    const detail = response.statusText || body;
    throw new Error(`Granola API error: ${response.status} ${detail ?? ''}`);
  }

  const data: unknown = await response.json();
  return data;
}

async function listNotes(
  config: ResolvedGranolaConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
) {
  const limit = optionalPositiveInteger(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const cursor = optionalString(args.cursor);
  const createdAfter = optionalString(args.createdAfter);
  const createdBefore = optionalString(args.createdBefore);
  const updatedAfter = optionalString(args.updatedAfter);
  const folderId = optionalString(args.folderId);

  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}/notes`);
  url.searchParams.set('page_size', limit.toString());
  if (cursor !== null) {
    url.searchParams.set('cursor', cursor);
  }
  if (createdAfter !== null) {
    url.searchParams.set('created_after', createdAfter);
  }
  if (createdBefore !== null) {
    url.searchParams.set('created_before', createdBefore);
  }
  if (updatedAfter !== null) {
    url.searchParams.set('updated_after', updatedAfter);
  }
  if (folderId !== null) {
    url.searchParams.set('folder_id', folderId);
  }

  return parseListResponse(await fetchGranolaJSON(config, url, signal));
}

async function listFolders(
  config: ResolvedGranolaConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
) {
  const limit = optionalPositiveInteger(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const cursor = optionalString(args.cursor);
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}/folders`);
  url.searchParams.set('page_size', limit.toString());
  if (cursor !== null) {
    url.searchParams.set('cursor', cursor);
  }

  return parseFolderListResponse(await fetchGranolaJSON(config, url, signal));
}

async function getNote(
  config: ResolvedGranolaConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
) {
  const noteId = requiredString(args, 'noteId');
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}/notes/${encodeURIComponent(noteId)}`);
  url.searchParams.set('include', 'transcript');

  return parseNote(await fetchGranolaJSON(config, url, signal));
}

export const GRANOLA_LIST_NOTES_DEFINITION: ToolDefinition = {
  name: 'granola_list_notes',
  description:
    'List recent Granola notes for the configured workbench. Use this to find calls before fetching a full transcript.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of notes to return. Defaults to 10 and caps at 30.',
      },
      cursor: {
        type: 'string',
        description: 'Pagination cursor returned by a prior Granola list response.',
      },
      createdAfter: {
        type: 'string',
        description:
          'Return only notes created after this date. ISO date (2026-01-27) or date-time (2026-01-27T15:30:00Z).',
      },
      createdBefore: {
        type: 'string',
        description:
          'Return only notes created before this date. ISO date (2026-01-27) or date-time (2026-01-27T15:30:00Z).',
      },
      updatedAfter: {
        type: 'string',
        description:
          'Return only notes updated after this date. ISO date (2026-01-27) or date-time (2026-01-27T15:30:00Z).',
      },
      folderId: {
        type: 'string',
        description:
          'Return only notes in this folder and its child folders. Use granola_list_folders to discover folder IDs.',
      },
    },
  },
};

export const GRANOLA_GET_NOTE_DEFINITION: ToolDefinition = {
  name: 'granola_get_note',
  description: 'Fetch a single Granola note, including its transcript, by note ID.',
  inputSchema: {
    type: 'object',
    properties: {
      noteId: {
        type: 'string',
        description: 'Granola note ID to fetch.',
      },
    },
    required: ['noteId'],
  },
};

export const GRANOLA_LIST_FOLDERS_DEFINITION: ToolDefinition = {
  name: 'granola_list_folders',
  description:
    'List Granola folders (Spaces) for the configured workbench, sorted alphabetically. Use this to discover folder IDs for filtering notes with granola_list_notes.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of folders to return. Defaults to 10 and caps at 30.',
      },
      cursor: {
        type: 'string',
        description: 'Pagination cursor returned by a prior Granola folders list response.',
      },
    },
  },
};

export function createGranolaTools(config: GranolaToolsConfig): AgentTool[] {
  const resolved: ResolvedGranolaConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl?.trim() || GRANOLA_DEFAULT_BASE_URL,
    ...(config.fetcher ? { fetcher: config.fetcher } : {}),
  };
  validateConfig(resolved);

  return [
    {
      kind: 'string',
      definition: GRANOLA_LIST_NOTES_DEFINITION,
      handler: async (args, signal) => jsonResult(await listNotes(resolved, args, signal)),
    },
    {
      kind: 'string',
      definition: GRANOLA_GET_NOTE_DEFINITION,
      handler: async (args, signal) => jsonResult(await getNote(resolved, args, signal)),
    },
    {
      kind: 'string',
      definition: GRANOLA_LIST_FOLDERS_DEFINITION,
      handler: async (args, signal) => jsonResult(await listFolders(resolved, args, signal)),
    },
  ];
}

/**
 * Hub tool registry entries for granola. Import and spread into the hub's
 * KNOWN_TOOLS to register. No hub logic changes needed when entries are added here.
 */
export const GRANOLA_HUB_TOOLS = {
  granola_list_notes: {
    definition: GRANOLA_LIST_NOTES_DEFINITION,
    providerName: 'granola' as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createGranolaTools({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseUrl: config.baseURL } : {}),
      }),
  },
  granola_get_note: {
    definition: GRANOLA_GET_NOTE_DEFINITION,
    providerName: 'granola' as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createGranolaTools({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseUrl: config.baseURL } : {}),
      }),
  },
  granola_list_folders: {
    definition: GRANOLA_LIST_FOLDERS_DEFINITION,
    providerName: 'granola' as const,
    createTools: (config: { apiKey: string; baseURL?: string }) =>
      createGranolaTools({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseUrl: config.baseURL } : {}),
      }),
  },
};
