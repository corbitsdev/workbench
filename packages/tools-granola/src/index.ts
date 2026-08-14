// A minimal Granola integration: fetch a single call note (with its
// transcript) by id. This is the one Granola capability the
// pain-point-collateral workflow needs — intake either pulls a
// transcript by note id through this tool, or a human pastes one
// directly, per CL-5995's spec. Anything else Granola's API exposes
// (listing notes, folders, briefs) is out of scope here; add it when a
// workflow actually needs it rather than speculatively.
//
// Kept deliberately small and dependency-free (arktype + fetch) so it
// stays a genuinely reusable integration any future Granola-backed
// workflow can pull in, independent of any one workflow's prompt or
// formatting choices.

import { type } from "arktype";
import type { AgentTool } from "@intx/agent";

/** Granola's public API base URL; override via `baseUrl` for tests. */
export const GRANOLA_DEFAULT_BASE_URL = "https://public-api.granola.ai/v1";

// Left as a plain type, not an arktype schema: `fetcher` is a function
// field, which arktype cannot express.
export type GranolaFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type GranolaToolsConfig = {
  apiKey: string;
  /** Defaults to {@link GRANOLA_DEFAULT_BASE_URL} when omitted or empty. */
  baseUrl?: string;
  fetcher?: GranolaFetch;
};

const GetNoteArgs = type({ noteId: "string > 0" });

const GranolaTranscriptSpeaker = type({
  source: "'microphone' | 'speaker'",
  "diarization_label?": "string",
});

const GranolaTranscriptItem = type({
  speaker: GranolaTranscriptSpeaker,
  text: "string",
});

const GranolaNote = type({
  id: "string",
  title: "string | null",
  created_at: "string",
  "participants?": "string[]",
  "summary?": "string",
  "transcript?": GranolaTranscriptItem.array(),
});

export type GranolaNote = typeof GranolaNote.infer;
export type GranolaTranscriptItem = typeof GranolaTranscriptItem.infer;

export class GranolaApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GranolaApiError";
    this.status = status;
  }
}

/**
 * Flattens a note's diarized transcript into plain speaker-labeled
 * lines, the shape a model reads best. Returns an empty string when
 * the note carries no transcript (e.g. a note without recorded audio)
 * — callers are expected to treat that as a missing transcript, not
 * paper over it.
 */
export function formatGranolaTranscript(note: GranolaNote): string {
  if (note.transcript === undefined || note.transcript.length === 0) {
    return "";
  }
  return note.transcript
    .map((line) => {
      const speaker = line.speaker.diarization_label ?? line.speaker.source;
      return `${speaker}: ${line.text}`;
    })
    .join("\n");
}

type ResolvedGranolaConfig = {
  apiKey: string;
  baseUrl: string;
  fetcher: GranolaFetch;
};

async function fetchNote(
  config: ResolvedGranolaConfig,
  noteId: string,
): Promise<GranolaNote> {
  const fetcher = config.fetcher;
  const response = await fetcher(
    `${config.baseUrl}/notes/${encodeURIComponent(noteId)}?include=transcript`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` },
    },
  );
  if (!response.ok) {
    throw new GranolaApiError(
      response.status,
      `Granola note fetch failed with status ${response.status}`,
    );
  }
  const body: unknown = await response.json();
  const out = GranolaNote(body);
  if (out instanceof type.errors) {
    throw new Error(
      `Granola note response did not match the expected shape: ${out.summary}`,
    );
  }
  return out;
}

/**
 * Builds the Granola agent tools for one deployment's credential. Empty
 * `apiKey` throws at construction — a workflow that reaches this point
 * with no Granola connection should say so plainly rather than call an
 * unauthenticated endpoint and surface a confusing 401 mid-run.
 */
export function createGranolaTools(config: GranolaToolsConfig): AgentTool[] {
  if (config.apiKey === "") {
    throw new Error("createGranolaTools requires a non-empty apiKey");
  }
  const resolved: ResolvedGranolaConfig = {
    apiKey: config.apiKey,
    baseUrl:
      config.baseUrl === undefined || config.baseUrl === ""
        ? GRANOLA_DEFAULT_BASE_URL
        : config.baseUrl,
    fetcher: config.fetcher ?? fetch,
  };

  return [
    {
      kind: "full",
      definition: {
        name: "granola_get_note",
        description:
          "Fetches a Granola call note, including its diarized transcript, by note id.",
        inputSchema: {
          type: "object",
          properties: {
            noteId: { type: "string", description: "The Granola note id." },
          },
          required: ["noteId"],
        },
      },
      handler: async (call) => {
        const parsedArgs = GetNoteArgs(call.arguments);
        if (parsedArgs instanceof type.errors) {
          return {
            callId: call.id,
            isError: true,
            content: `Invalid arguments for granola_get_note: ${parsedArgs.summary}`,
          };
        }
        try {
          const note = await fetchNote(resolved, parsedArgs.noteId);
          return {
            callId: call.id,
            isError: false,
            content: JSON.stringify({
              id: note.id,
              title: note.title,
              participants: note.participants ?? [],
              summary: note.summary ?? "",
              transcript: formatGranolaTranscript(note),
            }),
          };
        } catch (cause) {
          return {
            callId: call.id,
            isError: true,
            content:
              cause instanceof Error
                ? cause.message
                : `granola_get_note failed: ${String(cause)}`,
          };
        }
      },
    },
  ];
}
