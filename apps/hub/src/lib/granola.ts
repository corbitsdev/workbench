import { type } from "arktype";
import { loadConfig } from "../config";

/** Granola's public API caps page size at 30 and defaults to 10. */
const MAX_PAGE_SIZE = 30;

export const GranolaTranscriptItemSchema = type({
  speaker: {
    source: "'microphone' | 'speaker'",
    "diarization_label?": "string",
  },
  text: "string",
});
export type GranolaTranscriptItem = typeof GranolaTranscriptItemSchema.infer;

export const GranolaNoteSchema = type({
  id: "string",
  title: "string | null",
  created_at: "string",
  "participants?": "string[]",
  "summary?": "string",
  "transcript?": GranolaTranscriptItemSchema.array(),
});
export type GranolaNote = typeof GranolaNoteSchema.infer;

export const GranolaListResponseSchema = type({
  notes: GranolaNoteSchema.array(),
  hasMore: "boolean",
  "cursor?": "string",
});
export type GranolaListResponse = typeof GranolaListResponseSchema.infer;

function granolaHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function clampPageSize(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    return 1;
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}

async function fetchNotes(apiKey: string, url: URL): Promise<GranolaNote[]> {
  const response = await fetch(url.toString(), {
    headers: granolaHeaders(apiKey),
  });
  if (!response.ok) {
    throw new Error(
      `Granola API error: ${response.status} ${response.statusText}`,
    );
  }

  const raw = await response.json();
  const data = GranolaListResponseSchema(raw);
  if (data instanceof type.errors) {
    throw new Error(
      `Granola API returned an unexpected shape: ${data.summary}`,
    );
  }
  return data.notes;
}

export async function getRecentNotes(
  apiKey: string,
  limit = 3,
): Promise<GranolaNote[]> {
  const { baseUrl } = loadConfig().granola;

  const url = new URL(`${baseUrl}/notes`);
  url.searchParams.append("page_size", clampPageSize(limit).toString());

  return fetchNotes(apiKey, url);
}

export async function getNoteWithTranscript(
  apiKey: string,
  noteId: string,
): Promise<GranolaNote> {
  const { baseUrl } = loadConfig().granola;

  const url = new URL(`${baseUrl}/notes/${noteId}`);
  url.searchParams.append("include", "transcript");

  const response = await fetch(url.toString(), {
    headers: granolaHeaders(apiKey),
  });
  if (!response.ok) {
    throw new Error(
      `Granola API error: ${response.status} ${response.statusText}`,
    );
  }

  return response.json() as Promise<GranolaNote>;
}

export async function getRecentNotesSince(
  apiKey: string,
  since: Date,
  limit: number = MAX_PAGE_SIZE,
): Promise<GranolaNote[]> {
  const { baseUrl } = loadConfig().granola;

  const url = new URL(`${baseUrl}/notes`);
  url.searchParams.append("page_size", clampPageSize(limit).toString());
  url.searchParams.append("created_after", since.toISOString());

  return fetchNotes(apiKey, url);
}

export function transcriptToText(note: GranolaNote): string {
  if (!note.transcript) return "";
  return note.transcript
    .map((item) => {
      const label =
        item.speaker.diarization_label ||
        (item.speaker.source === "microphone" ? "You" : "Them");
      return `${label}: ${item.text}`;
    })
    .join("\n");
}
