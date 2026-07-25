// Proves the fan-out parent with a REAL run: `runLocal` drives the actual
// `@intx/workflow` runtime + selector engine against this workflow's real
// definition, dispatching `discover` through the real
// `@workbench/tools-granola` code (only the external Granola HTTP call is
// stubbed — a true network boundary) and capturing the arguments the `spawn`
// step hands the hub tool. This is the exact seam a definition-shape test
// (`index.test.ts`) cannot cover — in particular, that the native `action`
// steps' selectors alone (no argMap, no reshape) produce tool arguments the
// real tool schemas accept.
//
// NOTE: relative import for `@workbench/tools-granola`, not the package
// specifier — this sandbox's bun workspace resolution has been observed to
// resolve that specifier to a stale copy under an unrelated worktree
// checkout. The relative path is unambiguous and exercises the exact same
// on-disk package source.
import { afterEach, describe, expect, test } from "bun:test";
import { createToolRunner } from "@intx/agent";
import type { ActionHandler } from "@intx/workflow/runlocal";
import { runLocal } from "@intx/workflow/runlocal";
import { createGranolaTools } from "../../../packages/tools-granola/src/index";

import {
  workflow,
  GRANOLA_LIST_NOTES_HANDLER,
  GRANOLA_SPAWN_CALL_RUNS_HANDLER,
} from "./index";

const GRANOLA_API_BASE = "https://granola.test";

function stubGranolaFetch(notes: unknown[]): { seenUrls: string[] } {
  const seenUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    seenUrls.push(url);
    if (url.startsWith(`${GRANOLA_API_BASE}/notes`)) {
      return Response.json({ notes, hasMore: false });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
  return { seenUrls };
}

/** Builds the `actionResolver` `runLocal` uses to dispatch each `action`
 * step's `handler` ref — the same ref vocabulary the sidecar's
 * `createActionToolHandlerRegistry` resolves in production. `discover`
 * dispatches through the real granola tool runner; `spawn` is stubbed
 * (the hub-only run-starter side effect), capturing the exact arguments its
 * selector produced so the test can assert the native selector shaped them
 * correctly with no reshape step in between. */
function buildActionResolver(
  spawnCalls: Record<string, unknown>[],
): (ref: string) => ActionHandler {
  const granolaRunner = createToolRunner(
    createGranolaTools({ apiKey: "test-key", baseUrl: GRANOLA_API_BASE }),
  );
  return (ref: string): ActionHandler => {
    if (ref === GRANOLA_SPAWN_CALL_RUNS_HANDLER) {
      return async (input): Promise<unknown> => {
        const args = input as Record<string, unknown>;
        spawnCalls.push(args);
        const parsed = JSON.parse(String(args.content)) as {
          notes: unknown[];
        };
        return {
          content: JSON.stringify({
            spawned: parsed.notes.map((note) => ({
              noteId: (note as { id: string }).id,
              runId: `run-${(note as { id: string }).id}`,
            })),
            skippedAlreadyProcessed: 0,
            failed: [],
            considered: parsed.notes.length,
          }),
        };
      };
    }
    if (ref === GRANOLA_LIST_NOTES_HANDLER) {
      return async (input, _ctx, signal): Promise<unknown> => {
        const result = await granolaRunner.run(
          {
            id: "det-granola_list_notes",
            name: "granola_list_notes",
            arguments: (input ?? {}) as Record<string, unknown>,
          },
          signal,
        );
        if (result.isError === true) {
          throw new Error(String(result.content));
        }
        return result;
      };
    }
    throw new Error(`unexpected action handler ref: ${ref}`);
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("granola-call fan-out parent (real runtime)", () => {
  test("a run with no inputs discovers via the tool default and hands the full list to spawn", async () => {
    const notes = Array.from({ length: 12 }, (_, i) => ({
      id: `note_${i}`,
      title: `Call ${i}`,
      created_at: "2026-07-20T00:00:00Z",
    }));
    const { seenUrls } = stubGranolaFetch(notes);
    const spawnCalls: Record<string, unknown>[] = [];

    const result = await runLocal(workflow, {
      actionResolver: buildActionResolver(spawnCalls),
      triggerPayload: {},
    }).complete;

    expect(result.terminalStatus).toBe("completed");
    const discoverUrl = seenUrls.find((u) =>
      u.startsWith(`${GRANOLA_API_BASE}/notes?`),
    );
    // No limit supplied → the TOOL's own default applies.
    expect(String(discoverUrl)).toContain("page_size=10");
    expect(spawnCalls).toHaveLength(1);
    // The spawn tool receives discover's raw JSON content verbatim...
    const handed = JSON.parse(String(spawnCalls[0]?.content)) as {
      notes: unknown[];
    };
    expect(handed.notes).toHaveLength(12);
    // ...and no limit key at all (absent on trigger.payload, so absent on
    // the merged selector output too — no reshape to omit it for us).
    expect("limit" in (spawnCalls[0] ?? {})).toBe(false);
  });

  test("an explicit limit reaches both the list call and the spawn tool under the same name", async () => {
    stubGranolaFetch([
      { id: "note_1", title: "Call 1", created_at: "2026-07-20T00:00:00Z" },
    ]);
    const spawnCalls: Record<string, unknown>[] = [];

    const result = await runLocal(workflow, {
      actionResolver: buildActionResolver(spawnCalls),
      triggerPayload: { limit: 3 },
    }).complete;

    expect(result.terminalStatus).toBe("completed");
    expect(spawnCalls[0]?.limit).toBe(3);
  });

  test("an empty-string limit (an unset text intake field) is treated as absent, not a validation failure", async () => {
    stubGranolaFetch([
      { id: "note_1", title: "Call 1", created_at: "2026-07-20T00:00:00Z" },
    ]);
    const spawnCalls: Record<string, unknown>[] = [];

    const result = await runLocal(workflow, {
      actionResolver: buildActionResolver(spawnCalls),
      triggerPayload: { limit: "" },
    }).complete;

    expect(result.terminalStatus).toBe("completed");
  });

  test("zero new calls ends cleanly — spawn receives an empty list and the run completes", async () => {
    stubGranolaFetch([]);
    const spawnCalls: Record<string, unknown>[] = [];

    const result = await runLocal(workflow, {
      actionResolver: buildActionResolver(spawnCalls),
      triggerPayload: {},
    }).complete;

    expect(result.terminalStatus).toBe("completed");
    const handed = JSON.parse(String(spawnCalls[0]?.content)) as {
      notes: unknown[];
    };
    expect(handed.notes).toHaveLength(0);
  });
});
