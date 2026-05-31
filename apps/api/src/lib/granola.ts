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

const GRANOLA_BASE_URL = 'https://public-api.granola.ai/v1';

export class GranolaClient {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.GRANOLA_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('GRANOLA_API_KEY is not configured');
    }
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async getRecentNotes(limit: number = 3): Promise<GranolaNote[]> {
    const url = new URL(`${GRANOLA_BASE_URL}/notes`);
    url.searchParams.append('limit', limit.toString());

    const response = await fetch(url.toString(), { headers: this.headers });
    if (!response.ok) {
      throw new Error(`Granola API error: ${response.status} ${response.statusText}`);
    }

    const data: GranolaListResponse = await response.json();
    return data.notes || [];
  }

  async getNoteWithTranscript(noteId: string): Promise<GranolaNote> {
    const url = new URL(`${GRANOLA_BASE_URL}/notes/${noteId}`);
    url.searchParams.append('include', 'transcript');

    const response = await fetch(url.toString(), { headers: this.headers });
    if (!response.ok) {
      throw new Error(`Granola API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<GranolaNote>;
  }

  // Flatten transcript items into a plain string for LLM consumption
  static transcriptToText(note: GranolaNote): string {
    if (!note.transcript) return '';
    return note.transcript
      .map((item) => {
        const label =
          item.speaker.diarization_label || (item.speaker.source === 'microphone' ? 'You' : 'Them');
        return `${label}: ${item.text}`;
      })
      .join('\n');
  }
}
