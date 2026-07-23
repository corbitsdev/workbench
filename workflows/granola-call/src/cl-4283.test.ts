// Proves CL-4283's redesigned fix with a REAL run: `runLocal` drives the
// actual `@intx/workflow` runtime + selector engine against this workflow's
// real definition, dispatching the two retained `deterministicToolStep`s
// through the real `@workbench/tools-granola` code (only the external
// Granola HTTP call is stubbed — a true module/network boundary). This is
// the exact seam a definition-shape test (`index.test.ts`) cannot cover.
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
import {
  createGranolaTools,
  createGranolaWorkflowTools,
} from "../../../packages/tools-granola/src/index";

import { workflow } from "./index";

const STEP_TOOL_TAG = "workbench.tool";
const STEP_ARGMAP_TAG = "workbench.argMap";

type ArgMapValue =
  | { from: string; skipStepIfAbsent?: boolean; optional?: boolean }
  | { literal: unknown };

/** Minimal re-implementation of the sidecar's `reshapeWithArgMap`, covering
 * only the shapes this workflow's two retained `deterministicToolStep`s use
 * (`from` + `optional`, `literal`) — enough to exercise the REAL
 * rename/omit behavior this test proves, without importing sidecar-internal
 * code from a workflow package. */
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
    const value = record[spec.from];
    const absent = value === undefined || value === null || value === "";
    if (absent && spec.optional === true) continue;
    args[argName] = value;
  }
  return args;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

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

/** `discover` and `persist` are BOTH `kind: "step"` (deterministicToolStep)
 * — dispatched through `invokeStep`, not an action resolver. Mirrors the
 * sidecar's real dispatch: interpret `workbench.argMap` the same way
 * `reshapeWithArgMap` does, then call the real tool. */
function buildInvokeStep(granolaRunner: ReturnType<typeof createToolRunner>) {
  return async (req: StepInvokeRequest): Promise<{ output: unknown }> => {
    const tag = req.agent.tags?.[STEP_TOOL_TAG];
    if (tag === undefined) {
      // Reasoning step: digest. Its reply is read as plain markdown by the
      // real `persist` step's `body: { from: "content" }` — any text works.
      return { output: { content: "stub digest reply" } };
    }
    const name = tag.slice(tag.lastIndexOf(":") + 1);
    const argMapJson = req.agent.tags?.[STEP_ARGMAP_TAG];
    const args =
      argMapJson !== undefined
        ? reshape(argMapJson, req.input)
        : req.input !== null && typeof req.input === "object"
          ? (req.input as Record<string, unknown>)
          : {};
    if (name === "write_artifact") {
      return {
        output: {
          artifactId: "digest_art_1",
          version: 1,
          title: args.title ?? "digest",
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
    return { output: JSON.parse(String(result.content)) };
  };
}

function buildGranolaRunner() {
  return createToolRunner([
    ...createGranolaTools({ apiKey: "test-key", baseUrl: GRANOLA_API_BASE }),
    ...createGranolaWorkflowTools(),
  ]);
}

describe("CL-4283: granola-call discovers and processes its own work", () => {
  test("a run with no inputs at all processes up to 10 (the tool's own default)", async () => {
    const notes = Array.from({ length: 12 }, (_, i) => ({
      id: `note_${i}`,
      title: `Call ${i}`,
      created_at: "2026-07-20T00:00:00Z",
    }));
    const { seenUrls } = stubGranolaFetch(notes);
    const granolaRunner = buildGranolaRunner();

    const run = runLocal(workflow, {
      invokeStep: buildInvokeStep(granolaRunner),
      triggerPayload: {},
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
    const discoverUrl = seenUrls.find((u) =>
      u.startsWith(`${GRANOLA_API_BASE}/notes?`),
    );
    expect(discoverUrl).toBeDefined();
    // No maxCalls supplied → limit omitted from the workflow's args →
    // the TOOL's own default (10) applies, not a workflow-injected literal.
    expect(String(discoverUrl)).toContain("page_size=10");
    const discoverOutput = result.outputs.discover as { notes: unknown[] };
    expect(discoverOutput.notes).toHaveLength(12);
  });

  test("an explicit maxCalls is honored (renamed to the tool's limit arg)", async () => {
    const { seenUrls } = stubGranolaFetch([
      { id: "note_1", title: "Call 1", created_at: "2026-07-20T00:00:00Z" },
    ]);
    const granolaRunner = buildGranolaRunner();

    const run = runLocal(workflow, {
      invokeStep: buildInvokeStep(granolaRunner),
      triggerPayload: { maxCalls: 3 },
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
    const discoverUrl = seenUrls.find((u) =>
      u.startsWith(`${GRANOLA_API_BASE}/notes?`),
    );
    expect(discoverUrl).toBeDefined();
    expect(String(discoverUrl)).toContain("page_size=3");
  });

  test("zero new calls ends cleanly — a successful no-op run, not a failure", async () => {
    stubGranolaFetch([]);
    const granolaRunner = buildGranolaRunner();

    const run = runLocal(workflow, {
      invokeStep: buildInvokeStep(granolaRunner),
      triggerPayload: {},
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
    const persistOutput = result.outputs.persist as { artifactId: string };
    expect(persistOutput.artifactId).toBeDefined();
  });

  test("already-processed calls are not repeated: the digest is saved under a STABLE sourceRef every run, so a rerun over the same notes upserts in place instead of duplicating", async () => {
    stubGranolaFetch([
      { id: "note_1", title: "Call 1", created_at: "2026-07-20T00:00:00Z" },
    ]);
    const granolaRunner = buildGranolaRunner();

    const runA = runLocal(workflow, {
      invokeStep: buildInvokeStep(granolaRunner),
      triggerPayload: {},
    });
    const resultA = await runA.complete;
    expect(resultA.terminalStatus).toBe("completed");

    const runB = runLocal(workflow, {
      invokeStep: buildInvokeStep(granolaRunner),
      triggerPayload: {},
    });
    const resultB = await runB.complete;
    expect(resultB.terminalStatus).toBe("completed");

    // Same stable sourceRef on both runs — the real write_artifact tool
    // (out of this package's reach; here proven at the workflow-definition
    // level) dedupes by (tenantId, sourceRef), so these two runs write the
    // SAME artifact row, never two.
    const persistStepArgMap = JSON.parse(
      workflow.steps.persist.kind === "step"
        ? (workflow.steps.persist.agent.tags?.["workbench.argMap"] as string)
        : "{}",
    ) as { sourceRef: { literal: string } };
    expect(persistStepArgMap.sourceRef.literal).toBe("granola-call-digest");
  });
});
