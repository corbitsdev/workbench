import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  GRANOLA_GET_NOTE_TOOL,
  GRANOLA_LIST_RECENT_NOTES_TOOL,
  granolaTools,
} from "./tool";
import type { GranolaEnv } from "./tool";

const CALL: ToolCall = {
  id: "call_1",
  name: GRANOLA_LIST_RECENT_NOTES_TOOL,
  arguments: {},
};

const GET_NOTE_CALL: ToolCall = {
  id: "call_2",
  name: GRANOLA_GET_NOTE_TOOL,
  arguments: { noteId: "note_1" },
};

function fakeEnv(granolaApiKey: string | undefined): GranolaEnv {
  return { granolaApiKey } as unknown as GranolaEnv;
}

test("declares both the granola_list_recent_notes and granola_get_note tools", () => {
  const bundle = granolaTools(fakeEnv("key"));
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    GRANOLA_LIST_RECENT_NOTES_TOOL,
    GRANOLA_GET_NOTE_TOOL,
  ]);
});

test("degrades to a non-throwing 'not connected' error when no credential is set", async () => {
  const bundle = granolaTools(fakeEnv(undefined));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("degrades the same way for an empty-string credential", async () => {
  const bundle = granolaTools(fakeEnv(""));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
});

test("returns the notes as JSON content on a successful call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        notes: [
          {
            id: "note_1",
            title: "Weekly sync",
            createdAt: "2026-08-12T09:00:00.000Z",
          },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  try {
    const bundle = granolaTools(fakeEnv("key"));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content as string)).toEqual({
      notes: [
        {
          id: "note_1",
          title: "Weekly sync",
          createdAt: "2026-08-12T09:00:00.000Z",
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an error result (never throws) when the underlying call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  try {
    const bundle = granolaTools(fakeEnv("key"));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("granola_get_note degrades to a non-throwing 'not connected' error when no credential is set", async () => {
  const bundle = granolaTools(fakeEnv(undefined));
  const result = await bundle.run(GET_NOTE_CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("granola_get_note rejects a missing noteId without calling the network", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const bundle = granolaTools(fakeEnv("key"));
    const result = await bundle.run(
      { id: "call_3", name: GRANOLA_GET_NOTE_TOOL, arguments: {} },
      new AbortController().signal,
    );
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("noteId");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("granola_get_note returns the note as JSON content on a successful call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "note_1",
        title: "Discovery call",
        createdAt: "2026-08-12T09:00:00.000Z",
        transcript: [{ speaker: "Rep", text: "How's it going?" }],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  try {
    const bundle = granolaTools(fakeEnv("key"));
    const result = await bundle.run(
      GET_NOTE_CALL,
      new AbortController().signal,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as {
      note: { id: string; transcript: unknown[] };
    };
    expect(parsed.note.id).toBe("note_1");
    expect(parsed.note.transcript).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("granola_get_note degrades to an error result (never throws) when the underlying call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  try {
    const bundle = granolaTools(fakeEnv("key"));
    const result = await bundle.run(
      GET_NOTE_CALL,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
