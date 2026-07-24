// Proves the fan-out parent with a REAL run: `runLocal` drives the actual
// `@intx/workflow` runtime + selector engine against this workflow's real
// definition, dispatching `discover` through the real
// `@workbench/tools-granola` code (only the external Granola HTTP call is
// stubbed — a true network boundary) and capturing the arguments the `spawn`
// step hands the hub tool. This is the exact seam a definition-shape test
// (`index.test.ts`) cannot cover.
//
// NOTE: relative import for `@workbench/tools-granola`, not the package
// specifier — this sandbox's bun workspace resolution has been observed to
// resolve that specifier to a stale copy under an unrelated worktree
// checkout. The relative path is unambiguous and exercises the exact same
// on-disk package source.
import { afterEach, describe, expect, test } from "bun:test";
import { createToolRunner } from "@intx/agent";
import type { StepInvokeRequest } from "@intx/workflow";
import { runLocal } from "@intx/workflow/runlocal";
import { createGranolaTools } from "../../../packages/tools-granola/src/index";

import { workflow } from "./index";

const STEP_TOOL_TAG = "workbench.tool";
const STEP_ARGMAP_TAG = "workbench.argMap";

type ArgMapValue =
  | { from: string; skipStepIfAbsent?: boolean; optional?: boolean }
  | { literal: unknown };

/** Minimal re-implementation of the sidecar's `reshapeWithArgMap`, covering
 * only the shapes this workflow's steps use (`from` + `optional`, `literal`)
 * — enough to exercise the REAL rename/omit behavior, without importing
 * sidecar-internal code from a workflow package. */
function reshape(argMapJson: string, input: unknown): Record<string, unknown> {
  const argMap = JSON.parse(argMapJson) as Record<string, ArgMapValue>;
  const record =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const args: Record<string, unknown> = {};
  for (const [argName, spec] of Object.entries(argMap)) {
    if ("literal" in spec) {
      args[argName] = spec.literal;
      continue;
    }
    const present = spec.from in record;
    const value = present ? record[spec.from] : undefined;
    const absentOrEmpty = !present || value === "";
    if (absentOrEmpty && spec.optional === true) continue;
    if (!present) {
      // Mirrors the sidecar harness's required-field contract: a required
      // `from` absent on the evaluated input THROWS.
      throw new Error(
        `reshape: tool arg "${argName}" maps from input field "${spec.from}", but that field is absent on the evaluated step input`,
      );
    }
    args[argName] = value;
  }
  return args;
}

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

/** Dispatches `discover` through the real granola tool runner and stubs the
 * hub-backed `spawn` tool, capturing its reshaped arguments and returning
 * the hub tool's real output shape (a ToolResult whose `content` is the
 * JSON summary string). */
function buildInvokeStep(spawnCalls: Record<string, unknown>[]) {
  const granolaRunner = createToolRunner(
    createGranolaTools({ apiKey: "test-key", baseUrl: GRANOLA_API_BASE }),
  );
  return async (req: StepInvokeRequest): Promise<{ output: unknown }> => {
    const tag = req.agent.tags?.[STEP_TOOL_TAG];
    if (tag === undefined) {
      throw new Error(`unexpected non-tool step: ${req.agent.id}`);
    }
    const name = tag.slice(tag.lastIndexOf(":") + 1);
    const argMapJson = req.agent.tags?.[STEP_ARGMAP_TAG];
    const args =
      argMapJson !== undefined
        ? reshape(argMapJson, req.input)
        : (req.input as Record<string, unknown>);
    if (name === "granola_spawn_call_runs") {
      spawnCalls.push(args);
      const parsed = JSON.parse(String(args.content)) as { notes: unknown[] };
      return {
        output: {
          content: JSON.stringify({
            spawned: parsed.notes.map((note) => ({
              noteId: (note as { id: string }).id,
              runId: `run-${(note as { id: string }).id}`,
            })),
            skippedAlreadyProcessed: 0,
            failed: [],
            considered: parsed.notes.length,
          }),
        },
      };
    }
    const result = await granolaRunner.run(
      { id: `det-${name}`, name, arguments: args },
      req.signal,
    );
    if (result.isError === true) {
      throw new Error(String(result.content));
    }
    return { output: result };
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
      invokeStep: buildInvokeStep(spawnCalls),
      triggerPayload: {},
    }).complete;

    expect(result.terminalStatus).toBe("completed");
    const discoverUrl = seenUrls.find((u) =>
      u.startsWith(`${GRANOLA_API_BASE}/notes?`),
    );
    // No maxCalls supplied → limit omitted → the TOOL's own default applies.
    expect(String(discoverUrl)).toContain("page_size=10");
    expect(spawnCalls).toHaveLength(1);
    // The spawn tool receives discover's raw JSON content verbatim...
    const handed = JSON.parse(String(spawnCalls[0]?.content)) as {
      notes: unknown[];
    };
    expect(handed.notes).toHaveLength(12);
    // ...and no maxCalls key at all (optional + absent = omitted).
    expect("maxCalls" in (spawnCalls[0] ?? {})).toBe(false);
  });

  test("an explicit maxCalls reaches both the list call and the spawn tool", async () => {
    stubGranolaFetch([
      { id: "note_1", title: "Call 1", created_at: "2026-07-20T00:00:00Z" },
    ]);
    const spawnCalls: Record<string, unknown>[] = [];

    const result = await runLocal(workflow, {
      invokeStep: buildInvokeStep(spawnCalls),
      triggerPayload: { maxCalls: 3 },
    }).complete;

    expect(result.terminalStatus).toBe("completed");
    expect(spawnCalls[0]?.maxCalls).toBe(3);
  });

  test("zero new calls ends cleanly — spawn receives an empty list and the run completes", async () => {
    stubGranolaFetch([]);
    const spawnCalls: Record<string, unknown>[] = [];

    const result = await runLocal(workflow, {
      invokeStep: buildInvokeStep(spawnCalls),
      triggerPayload: {},
    }).complete;

    expect(result.terminalStatus).toBe("completed");
    const handed = JSON.parse(String(spawnCalls[0]?.content)) as {
      notes: unknown[];
    };
    expect(handed.notes).toHaveLength(0);
  });
});
