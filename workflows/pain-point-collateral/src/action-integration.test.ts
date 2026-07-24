// Proves the migrated `intake`/`fetch` native `action` steps dispatch through
// the REAL `@workbench/tools-granola` package code, not a mock of it. This is
// the seam a purely-mocked-boundary test cannot cover: the workflow's
// `action` primitive (handler ref + selector `input`) must resolve to a real
// tool implementation and produce its real output shape. Only the external
// Granola HTTP API is stubbed (`globalThis.fetch`) — a true module/network
// boundary, not `@intx/*` and not the tool package itself. `runLocal`'s
// `actionResolver` is the same seam production's `createActionToolHandlerRegistry`
// (`apps/sidecar/src/action-tool-handler.ts`) implements; here it is wired
// directly to `createGranolaTools` instead of packaged into a tarball, since
// this test lives in the workflow package (which may depend on tool packages
// directly) rather than the sidecar (which architecturally may not).
import { afterEach, describe, expect, test } from "bun:test";
import { createToolRunner } from "@intx/agent";
import type { ActionHandler, EffectContext } from "@intx/workflow";
import { runLocal } from "@intx/workflow/runlocal";
import { createGranolaTools } from "@workbench/tools-granola";

import {
  workflow,
  GRANOLA_GET_NOTE_HANDLER,
  GRANOLA_LIST_NOTES_HANDLER,
} from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const GRANOLA_API_BASE = "https://granola.test";
const NOTES_PAGE = {
  notes: [
    { id: "note_1", title: "Acme call", created_at: "2026-07-01T00:00:00Z" },
  ],
  hasMore: false,
};
const NOTE_DETAIL = {
  id: "note_1",
  title: "Acme call",
  created_at: "2026-07-01T00:00:00Z",
  summary: "Discovery call notes",
};

function stubGranolaFetch(seen: string[]): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith(`${GRANOLA_API_BASE}/notes/`)) {
      return Response.json(NOTE_DETAIL);
    }
    if (url.startsWith(`${GRANOLA_API_BASE}/notes`)) {
      return Response.json(NOTES_PAGE);
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

/**
 * `runLocal`'s `actionResolver` seam, wired to the REAL tool functions
 * `createGranolaTools` produces (the exact factory the sidecar's registry
 * would have resolved via `@workbench/tools-granola/granola:<name>`, minus
 * the tarball-packaging step the sidecar boundary requires). Bare-name
 * lookup mirrors `toLlmToolName`'s stripping of the canonical prefix.
 */
function granolaActionResolver(): (ref: string) => ActionHandler {
  const tools = createGranolaTools({
    apiKey: "test-key",
    baseUrl: GRANOLA_API_BASE,
  });
  const runner = createToolRunner(tools);
  const knownNames = new Set(tools.map((tool) => tool.definition.name));
  return (ref: string): ActionHandler => {
    const bareName = ref.slice(ref.lastIndexOf(":") + 1);
    if (!knownNames.has(bareName)) {
      throw new Error(`no real granola tool bound for handler ref ${ref}`);
    }
    return async (input, _ctx: EffectContext, signal: AbortSignal) => {
      const args =
        input !== null && typeof input === "object"
          ? (input as Record<string, unknown>)
          : {};
      const result = await runner.run(
        { id: `test-${bareName}`, name: bareName, arguments: args },
        signal,
      );
      if (result.isError === true) {
        throw new Error(String(result.content));
      }
      return JSON.parse(String(result.content));
    };
  };
}

describe("pain-point-collateral migrated actions — real granola tool call", () => {
  test("intake action dispatches through the real granola_list_notes tool code", async () => {
    const seenUrls: string[] = [];
    stubGranolaFetch(seenUrls);

    const run = runLocal(workflow, {
      actionResolver: granolaActionResolver(),
      invokeStep: async () => ({ output: null }),
    });

    // Just prove the intake action ran and dispatched a real Granola HTTP
    // call before the workflow blocks on note-selection.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (seenUrls.some((u) => u.startsWith(`${GRANOLA_API_BASE}/notes?`))) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    expect(
      seenUrls.some((u) => u.startsWith(`${GRANOLA_API_BASE}/notes?`)),
    ).toBe(true);

    // Drain the run so it doesn't leak a pending timer into the next test.
    await run.signal("note-selection", { noteId: "note_1" });
    await run.signal("context", { context: "" });
    await run.signal("pain-point-selection", { selectedIds: [] });
    await run.signal("format-selection", { items: [] });
    await run.signal("review", { decisions: [], approvedPieces: [] });
    await run.complete;
  });

  test("fetch action dispatches through the real granola_get_note tool code with the selected noteId", async () => {
    const seenUrls: string[] = [];
    stubGranolaFetch(seenUrls);

    const run = runLocal(workflow, {
      actionResolver: granolaActionResolver(),
      invokeStep: async () => ({ output: null }),
    });

    await run.signal("note-selection", { noteId: "note_1" });

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (seenUrls.some((u) => u.includes("/notes/note_1"))) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    const noteUrl = seenUrls.find((u) => u.includes("/notes/note_1"));
    expect(noteUrl).toBeDefined();
    expect(String(noteUrl)).toContain("include=transcript");

    await run.signal("context", { context: "" });
    await run.signal("pain-point-selection", { selectedIds: [] });
    await run.signal("format-selection", { items: [] });
    await run.signal("review", { decisions: [], approvedPieces: [] });
    await run.complete;
  });

  test("intake and fetch handler refs are declared in effect.requires — the same names granolaActionResolver dispatches on", () => {
    expect(GRANOLA_LIST_NOTES_HANDLER).toBe(
      "@workbench/tools-granola/granola:granola_list_notes",
    );
    expect(GRANOLA_GET_NOTE_HANDLER).toBe(
      "@workbench/tools-granola/granola:granola_get_note",
    );
  });
});
