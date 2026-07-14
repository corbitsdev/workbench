import { describe, expect, mock, test } from "bun:test";
import { getLogger } from "@intx/log";

// createGranolaTools is mocked at the @workbench/tools-granola boundary: this
// test drives poll → per-note fetch → pipeline hand-off with a fake Granola API
// and a fake pipeline, so the source's own wiring (list, get, dedupe delegation)
// is the unit under test.
const listResult: {
  notes: { id: string; title: string; created_at: string }[];
  has_more?: boolean;
} = {
  notes: [
    { id: "note-1", title: "Discovery", created_at: "2026-07-01T00:00:00Z" },
    { id: "note-2", title: "Follow-up", created_at: "2026-07-02T00:00:00Z" },
  ],
};
const fullNotes: Record<string, unknown> = {
  "note-1": {
    id: "note-1",
    title: "Discovery",
    participants: ["a@corbits.io"],
    transcript: [{ text: "hello" }, { text: "world" }],
  },
  "note-2": {
    id: "note-2",
    title: "Follow-up",
    participants: ["b@corbits.io"],
  },
};
let lastListArgs: Record<string, unknown> | null = null;
mock.module("@workbench/tools-granola", () => ({
  createGranolaTools: () => [
    {
      kind: "string",
      definition: { name: "granola_list_notes" },
      handler: async (args: Record<string, unknown>) => {
        lastListArgs = args;
        return JSON.stringify(listResult);
      },
    },
    {
      kind: "string",
      definition: { name: "granola_get_note" },
      handler: async (args: Record<string, unknown>) =>
        JSON.stringify(fullNotes[args.noteId as string]),
    },
  ],
}));

const { createGranolaWorkspaceInboxSource, GRANOLA_WORKSPACE_SOURCE_KEY } =
  await import("./granola-workspace");
import type { WorkspaceInboxSourceContext } from "../inbox-source-registry";
import type {
  GranolaCallPipeline,
  ProcessCallInput,
  ProcessCallResult,
} from "../granola-call-pipeline";

function makeCtx(
  overrides: Partial<WorkspaceInboxSourceContext> = {},
): WorkspaceInboxSourceContext {
  return {
    scope: "workspace",
    db: {} as never,
    tenantId: "ten-1",
    credential: { apiKey: "k", baseURL: "", source: "tenant" },
    cutoff: new Date("2026-06-30T00:00:00Z"),
    perSourceLimit: 25,
    signal: new AbortController().signal,
    log: getLogger(["test"]),
    ...overrides,
  };
}

function fakePipeline(
  results: Record<string, ProcessCallResult["status"]> = {},
): { pipeline: GranolaCallPipeline; calls: ProcessCallInput[] } {
  const calls: ProcessCallInput[] = [];
  const pipeline: GranolaCallPipeline = {
    processCall: async (input) => {
      calls.push(input);
      const status = results[input.note.id] ?? "processed";
      if (status === "processed")
        return { status, artifactId: `art-${input.note.id}`, delivered: 1 };
      if (status === "skipped-duplicate") return { status };
      return { status: "skipped-no-source" };
    },
  };
  return { pipeline, calls };
}

describe("granola workspace inbox source", () => {
  test("has the workspace scope and the granola provider key", () => {
    const { pipeline } = fakePipeline();
    const source = createGranolaWorkspaceInboxSource({ pipeline });
    expect(source.scope).toBe("workspace");
    // Key MUST equal the tenant-credential provider name resolved by the core.
    expect(source.key).toBe(GRANOLA_WORKSPACE_SOURCE_KEY);
    expect(source.key).toBe("granola");
  });

  test("lists notes since cutoff, fetches each full note, hands off to the pipeline", async () => {
    const { pipeline, calls } = fakePipeline();
    const source = createGranolaWorkspaceInboxSource({ pipeline });

    await source.handle(makeCtx());

    expect(lastListArgs?.createdAfter).toBe("2026-06-30T00:00:00.000Z");
    expect(calls.map((c) => c.note.id)).toEqual(["note-1", "note-2"]);
    // Transcript items are flattened to text for the pipeline.
    expect(calls[0]?.note.transcript).toBe("hello\nworld");
    expect(calls[0]?.note.participants).toEqual(["a@corbits.io"]);
  });

  test("uses the later of cutoff and lastPollAt as the fetch floor", async () => {
    const { pipeline } = fakePipeline();
    const source = createGranolaWorkspaceInboxSource({ pipeline });
    await source.handle(
      makeCtx({ lastPollAt: new Date("2026-07-05T00:00:00Z") }),
    );
    expect(lastListArgs?.createdAfter).toBe("2026-07-05T00:00:00.000Z");
  });

  test("dedupe is delegated to the idempotent pipeline (already-processed notes short-circuit there)", async () => {
    const { pipeline, calls } = fakePipeline({ "note-1": "skipped-duplicate" });
    const source = createGranolaWorkspaceInboxSource({ pipeline });
    await source.handle(makeCtx());
    // Both notes are still handed off; the pipeline decides note-1 is a dup.
    expect(calls.map((c) => c.note.id)).toEqual(["note-1", "note-2"]);
  });

  test("a member-scope context is ignored (workspace source only runs workspace ticks)", async () => {
    const { pipeline, calls } = fakePipeline();
    const source = createGranolaWorkspaceInboxSource({ pipeline });
    await source.handle({ scope: "member" } as never);
    expect(calls).toEqual([]);
  });

  test("a full, limit-capped page reports nextCursor pinned at `since` (cursor does not advance)", async () => {
    const { pipeline } = fakePipeline();
    const source = createGranolaWorkspaceInboxSource({ pipeline });
    const since = new Date("2026-06-30T00:00:00Z");
    const result = await source.handle(
      makeCtx({ cutoff: since, perSourceLimit: 2 }),
    );
    expect(result).toEqual({ nextCursor: since });
  });

  test("a partial page reports no nextCursor (core advances the cursor)", async () => {
    const { pipeline } = fakePipeline();
    const source = createGranolaWorkspaceInboxSource({ pipeline });
    const result = await source.handle(
      makeCtx({
        cutoff: new Date("2026-06-30T00:00:00Z"),
        perSourceLimit: 25,
      }),
    );
    expect(result).toBeUndefined();
  });

  test("prefers the list response's has_more signal over the length heuristic", async () => {
    listResult.has_more = true;
    try {
      const { pipeline } = fakePipeline();
      const source = createGranolaWorkspaceInboxSource({ pipeline });
      const since = new Date("2026-06-30T00:00:00Z");
      // perSourceLimit is well above notes.length, so the length heuristic
      // alone would say "not truncated" — has_more must override it.
      const result = await source.handle(
        makeCtx({ cutoff: since, perSourceLimit: 25 }),
      );
      expect(result).toEqual({ nextCursor: since });
    } finally {
      delete listResult.has_more;
    }
  });
});
