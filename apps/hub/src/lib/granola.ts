import { loadConfig } from '../config';

interface GranolaTranscriptItem {
  speaker: { source: 'microphone' | 'speaker'; diarization_label?: string };
  text: string;
}

export interface GranolaNote {
  id: string;
  title: string;
  created_at: string;
  participants?: string[];
  summary?: string;
  transcript?: GranolaTranscriptItem[];
}

interface GranolaListResponse {
  notes: GranolaNote[];
  hasMore: boolean;
  cursor?: string;
}

function granolaHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

export async function getRecentNotes(apiKey: string, limit: number = 3): Promise<GranolaNote[]> {
  const { baseUrl } = loadConfig().granola;

  const url = new URL(`${baseUrl}/notes`);
  url.searchParams.append('limit', limit.toString());

  const response = await fetch(url.toString(), { headers: granolaHeaders(apiKey) });
  if (!response.ok) {
    throw new Error(`Granola API error: ${response.status} ${response.statusText}`);
  }

  const data: GranolaListResponse = await response.json();
  return data.notes || [];
}

export async function getNoteWithTranscript(apiKey: string, noteId: string): Promise<GranolaNote> {
  const { baseUrl } = loadConfig().granola;

  const url = new URL(`${baseUrl}/notes/${noteId}`);
  url.searchParams.append('include', 'transcript');

  const response = await fetch(url.toString(), { headers: granolaHeaders(apiKey) });
  if (!response.ok) {
    throw new Error(`Granola API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<GranolaNote>;
}

export async function getRecentNotesSince(
  apiKey: string,
  since: Date,
  limit: number = 50
): Promise<GranolaNote[]> {
  const notes = await getRecentNotes(apiKey, limit);
  return notes.filter((n) => new Date(n.created_at) > since);
}

export function transcriptToText(note: GranolaNote): string {
  if (!note.transcript) return '';
  return note.transcript
    .map((item) => {
      const label =
        item.speaker.diarization_label || (item.speaker.source === 'microphone' ? 'You' : 'Them');
      return `${label}: ${item.text}`;
    })
    .join('\n');
}
