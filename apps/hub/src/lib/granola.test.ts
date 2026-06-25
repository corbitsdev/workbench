import { describe, it, expect, afterEach, mock } from "bun:test";

const mockConfig = {
  granola: {
    apiKey: "test-api-key",
    baseUrl: "https://public-api.granola.ai/v1",
  },
};

mock.module("../config", () => ({
  loadConfig: () => mockConfig,
}));

import {
  getRecentNotes,
  getRecentNotesSince,
  getNoteWithTranscript,
  transcriptToText,
} from "./granola";

const TEST_API_KEY = "test-api-key";

describe("granola", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it("getRecentNotes returns parsed notes", async () => {
    const mockNotes = [
      {
        id: "n1",
        title: "Sales Call",
        created_at: "2026-05-28T10:00:00Z",
        participants: ["Alice"],
      },
      {
        id: "n2",
        title: "Team Sync",
        created_at: "2026-05-28T09:00:00Z",
        participants: ["Bob"],
      },
    ];

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ notes: mockNotes, hasMore: false }), {
          status: 200,
        }),
      ),
    );
    (global as any).fetch = fetchMock;

    const notes = await getRecentNotes(TEST_API_KEY, 2);
    expect(notes).toEqual(mockNotes);
    const url = new URL(
      String((fetchMock.mock.calls as unknown as any[][])[0]?.[0]),
    );
    expect(url.searchParams.get("page_size")).toBe("2");
    expect(url.searchParams.has("limit")).toBe(false);
  });

  it("getRecentNotes caps page_size at the API maximum of 30", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ notes: [], hasMore: false }), {
          status: 200,
        }),
      ),
    );
    (global as any).fetch = fetchMock;

    await getRecentNotes(TEST_API_KEY, 1000);
    const url = new URL(
      String((fetchMock.mock.calls as unknown as any[][])[0]?.[0]),
    );
    expect(url.searchParams.get("page_size")).toBe("30");
  });

  it("getRecentNotesSince filters server-side with created_after", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ notes: [], hasMore: false }), {
          status: 200,
        }),
      ),
    );
    (global as any).fetch = fetchMock;

    const since = new Date("2026-05-28T00:00:00Z");
    await getRecentNotesSince(TEST_API_KEY, since);
    const url = new URL(
      String((fetchMock.mock.calls as unknown as any[][])[0]?.[0]),
    );
    expect(url.searchParams.get("created_after")).toBe(since.toISOString());
  });

  it("getNoteWithTranscript includes transcript param", async () => {
    const mockNote = {
      id: "n1",
      title: "Sales Call",
      created_at: "2026-05-28T10:00:00Z",
      transcript: [
        { speaker: { source: "microphone" as const }, text: "Hello there" },
        { speaker: { source: "speaker" as const }, text: "Hi back" },
      ],
    };

    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(mockNote), { status: 200 })),
    );
    (global as any).fetch = fetchMock;

    const note = await getNoteWithTranscript(TEST_API_KEY, "n1");
    expect(note.transcript).toEqual(mockNote.transcript);
    const calls = fetchMock.mock.calls as unknown as any[][];
    expect(String(calls[0]?.[0]).includes("include=transcript")).toBe(true);
  });

  it("transcriptToText flattens items to plain text", () => {
    const note = {
      id: "n1",
      title: "Sales Call",
      created_at: "2026-05-28T10:00:00Z",
      transcript: [
        {
          speaker: { source: "microphone" as const },
          text: "We need faster deploys",
        },
        {
          speaker: { source: "speaker" as const },
          text: "Our pipeline takes 40 minutes",
        },
      ],
    };

    expect(transcriptToText(note)).toBe(
      "You: We need faster deploys\nThem: Our pipeline takes 40 minutes",
    );
  });

  it("getRecentNotes throws on non-200 response", async () => {
    (global as any).fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        }),
      ),
    );

    expect(async () => getRecentNotes(TEST_API_KEY, 3)).toThrow();
  });
});
