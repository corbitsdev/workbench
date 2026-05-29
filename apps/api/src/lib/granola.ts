interface GranolaNote {
  id: string;
  title: string;
  created_at: string;
  participants?: string[];
  transcript?: string;
}

interface GranolaListResponse {
  data: GranolaNote[];
  cursor?: string;
}

interface GranolaNoteResponse {
  data: GranolaNote;
}

export class GranolaClient {
  private apiKey: string;
  private apiUrl: string;

  constructor() {
    this.apiKey = process.env.GRANOLA_API_KEY || "";
    this.apiUrl = process.env.GRANOLA_API_URL || "";

    if (!this.apiKey) {
      throw new Error("GRANOLA_API_KEY is not configured");
    }
    if (!this.apiUrl) {
      throw new Error("GRANOLA_API_URL is not configured");
    }
  }

  async getRecentNotes(limit: number = 3): Promise<GranolaNote[]> {
    const url = new URL(`${this.apiUrl}/v1/notes`);
    url.searchParams.append("limit", limit.toString());

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Granola API error: ${response.status} ${response.statusText}`
      );
    }

    const data: GranolaListResponse = await response.json();
    return data.data || [];
  }

  async getNoteWithTranscript(noteId: string): Promise<GranolaNote> {
    const url = new URL(`${this.apiUrl}/v1/notes/${noteId}`);
    url.searchParams.append("include", "transcript");

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Granola API error: ${response.status} ${response.statusText}`
      );
    }

    const data: GranolaNoteResponse = await response.json();
    return data.data;
  }
}

export type { GranolaNote };
