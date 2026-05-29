import { describe, it, expect, beforeEach, mock } from "bun:test";
import { GranolaClient } from "./granola";

describe("GranolaClient", () => {
  let client: GranolaClient;

  beforeEach(() => {
    process.env.GRANOLA_API_KEY = "test-api-key";
    process.env.GRANOLA_API_URL = "https://api.granola.ai";
    client = new GranolaClient();
  });

  it("throws error if API key is missing", () => {
    delete process.env.GRANOLA_API_KEY;
    expect(() => {
      new GranolaClient();
    }).toThrow("GRANOLA_API_KEY is not configured");
  });

  it("throws error if API URL is missing", () => {
    delete process.env.GRANOLA_API_URL;
    expect(() => {
      new GranolaClient();
    }).toThrow("GRANOLA_API_URL is not configured");
  });

  it("fetches recent notes with correct headers", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "note-1",
                title: "Sales Call",
                created_at: "2026-05-28T10:00:00Z",
                participants: ["Alice", "Bob"],
              },
              {
                id: "note-2",
                title: "Internal Sync",
                created_at: "2026-05-28T09:00:00Z",
                participants: ["Alice"],
              },
              {
                id: "note-3",
                title: "Team Meeting",
                created_at: "2026-05-28T08:00:00Z",
                participants: ["Alice", "Bob", "Carol"],
              },
            ],
            cursor: "next-page-cursor",
          }),
          { status: 200 }
        )
      )
    );

    global.fetch = mockFetch as any;

    const notes = await client.getRecentNotes(3);

    expect(notes).toHaveLength(3);
    expect(notes[0].id).toBe("note-1");
    expect(notes[0].title).toBe("Sales Call");

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toContain("/v1/notes");
    expect((callArgs[1] as any).headers.Authorization).toBe(
      "Bearer test-api-key"
    );
  });

  it("fetches note with transcript", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              id: "note-1",
              title: "Sales Call",
              transcript: "Speaker 1: Hello\nSpeaker 2: Hi there",
              created_at: "2026-05-28T10:00:00Z",
            },
          }),
          { status: 200 }
        )
      )
    );

    global.fetch = mockFetch as any;

    const note = await client.getNoteWithTranscript("note-1");

    expect(note.id).toBe("note-1");
    expect(note.transcript).toBe("Speaker 1: Hello\nSpeaker 2: Hi there");

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toContain("/v1/notes/note-1");
    expect(callArgs[0]).toContain("include=transcript");
  });

  it("handles API errors gracefully", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401 }
        )
      )
    );

    global.fetch = mockFetch as any;

    expect(async () => {
      await client.getRecentNotes(3);
    }).toThrow();
  });
});
