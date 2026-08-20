import { expect, test } from "bun:test";

import { getGranolaNote, listRecentGranolaNotes } from "./client";

const NOTE = {
  id: "note_1",
  title: "Weekly sync",
  summary: "Discussed roadmap.",
  createdAt: "2026-08-12T09:00:00.000Z",
};

test("returns the parsed notes on a successful call", async () => {
  const fetchImpl = (async (input: URL | string) => {
    expect(String(input)).toBe("https://api.granola.ai/v1/notes");
    return new Response(JSON.stringify({ notes: [NOTE] }), { status: 200 });
  }) as unknown as typeof fetch;

  const notes = await listRecentGranolaNotes({
    apiKey: "test-key",
    fetchImpl,
  });
  expect(notes).toEqual([NOTE]);
});

test("carries the since parameter and bearer auth header", async () => {
  const captured: { url: string; auth: string | null } = {
    url: "",
    auth: null,
  };
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    captured.url = String(input);
    captured.auth =
      (init?.headers as Record<string, string> | undefined)?.[
        "authorization"
      ] ?? null;
    return new Response(JSON.stringify({ notes: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await listRecentGranolaNotes(
    { apiKey: "secret", fetchImpl },
    { since: "2026-08-01T00:00:00.000Z" },
  );
  expect(captured.url).toBe(
    "https://api.granola.ai/v1/notes?since=2026-08-01T00%3A00%3A00.000Z",
  );
  expect(captured.auth).toBe("Bearer secret");
});

test("throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 401 })) as unknown as typeof fetch;

  await expect(
    listRecentGranolaNotes({ apiKey: "bad", fetchImpl }),
  ).rejects.toThrow(/401/);
});

test("throws when the response body does not match the expected shape", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ notes: [{ id: "note_1" }] }), {
      status: 200,
    })) as unknown as typeof fetch;

  await expect(
    listRecentGranolaNotes({ apiKey: "test-key", fetchImpl }),
  ).rejects.toThrow(/did not match the expected shape/);
});

test("getGranolaNote fetches one note by id with its transcript", async () => {
  const captured: { url: string; auth: string | null } = {
    url: "",
    auth: null,
  };
  const noteWithTranscript = {
    ...NOTE,
    transcript: [
      { speaker: "Rep", text: "How's your current setup?" },
      { speaker: "Prospect", text: "It's slow and hard to configure." },
    ],
  };
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    captured.url = String(input);
    captured.auth =
      (init?.headers as Record<string, string> | undefined)?.[
        "authorization"
      ] ?? null;
    return new Response(JSON.stringify(noteWithTranscript), { status: 200 });
  }) as unknown as typeof fetch;

  const note = await getGranolaNote(
    { apiKey: "test-key", fetchImpl },
    { noteId: "note_1" },
  );
  expect(captured.url).toBe(
    "https://api.granola.ai/v1/notes/note_1?include=transcript",
  );
  expect(captured.auth).toBe("Bearer test-key");
  expect(note).toEqual(noteWithTranscript);
});

test("getGranolaNote throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("not found", { status: 404 })) as unknown as typeof fetch;

  await expect(
    getGranolaNote({ apiKey: "test-key", fetchImpl }, { noteId: "missing" }),
  ).rejects.toThrow(/404/);
});

test("getGranolaNote throws when the response body does not match the expected shape", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ id: "note_1" }), {
      status: 200,
    })) as unknown as typeof fetch;

  await expect(
    getGranolaNote({ apiKey: "test-key", fetchImpl }, { noteId: "note_1" }),
  ).rejects.toThrow(/did not match the expected shape/);
});
