import { expect, test } from "bun:test";

import { listRecentGranolaNotes } from "./client";

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
