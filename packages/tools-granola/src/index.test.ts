import { expect, test } from "bun:test";

import {
  createGranolaTools,
  formatGranolaTranscript,
  GRANOLA_DEFAULT_BASE_URL,
  type GranolaNote,
} from "./index";

const FIXTURE_NOTE: GranolaNote = {
  id: "note_1",
  title: "Acme Corp discovery call",
  created_at: "2026-08-01T00:00:00.000Z",
  participants: ["Rep", "Prospect"],
  summary: "Prospect is evaluating vendors.",
  transcript: [
    {
      speaker: { source: "microphone", diarization_label: "Rep" },
      text: "How's your current setup?",
    },
    {
      speaker: { source: "speaker", diarization_label: "Prospect" },
      text: "It's slow and hard to configure.",
    },
  ],
};

test("createGranolaTools rejects an empty api key", () => {
  expect(() => createGranolaTools({ apiKey: "" })).toThrow(/apiKey/);
});

test("granola_get_note fetches the note by id against the configured base url", async () => {
  let requestedUrl = "";
  let requestedAuth = "";
  const tools = createGranolaTools({
    apiKey: "test-key",
    fetcher: async (input, init) => {
      requestedUrl = input;
      requestedAuth =
        (init.headers as Record<string, string>)["Authorization"] ?? "";
      return new Response(JSON.stringify(FIXTURE_NOTE), { status: 200 });
    },
  });

  const tool = tools[0];
  if (tool === undefined || tool.kind !== "full") {
    throw new Error("expected the granola_get_note full tool");
  }

  const result = await tool.handler(
    { id: "call_1", name: "granola_get_note", arguments: { noteId: "note_1" } },
    new AbortController().signal,
  );

  expect(requestedUrl).toBe(
    `${GRANOLA_DEFAULT_BASE_URL}/notes/note_1?include=transcript`,
  );
  expect(requestedAuth).toBe("Bearer test-key");
  expect(result.isError).toBe(false);
  const parsed = JSON.parse(result.content as string) as {
    id: string;
    transcript: string;
  };
  expect(parsed.id).toBe("note_1");
  expect(parsed.transcript).toBe(
    "Rep: How's your current setup?\nProspect: It's slow and hard to configure.",
  );
});

test("granola_get_note surfaces a non-ok response as a tool error, not a thrown exception", async () => {
  const tools = createGranolaTools({
    apiKey: "test-key",
    fetcher: async () => new Response("not found", { status: 404 }),
  });
  const tool = tools[0];
  if (tool === undefined || tool.kind !== "full") {
    throw new Error("expected the granola_get_note full tool");
  }

  const result = await tool.handler(
    {
      id: "call_1",
      name: "granola_get_note",
      arguments: { noteId: "missing" },
    },
    new AbortController().signal,
  );

  expect(result.isError).toBe(true);
  expect(result.content).toContain("404");
});

test("granola_get_note rejects a missing noteId without calling the network", async () => {
  let called = false;
  const tools = createGranolaTools({
    apiKey: "test-key",
    fetcher: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });
  const tool = tools[0];
  if (tool === undefined || tool.kind !== "full") {
    throw new Error("expected the granola_get_note full tool");
  }

  const result = await tool.handler(
    { id: "call_1", name: "granola_get_note", arguments: {} },
    new AbortController().signal,
  );

  expect(called).toBe(false);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});

test("formatGranolaTranscript returns an empty string for a note with no transcript", () => {
  const { transcript: _omitted, ...noteWithoutTranscript } = FIXTURE_NOTE;
  expect(formatGranolaTranscript(noteWithoutTranscript)).toBe("");
});
