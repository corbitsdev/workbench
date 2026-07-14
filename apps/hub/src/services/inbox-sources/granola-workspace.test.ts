import { describe, expect, mock, test } from "bun:test";
import { getLogger } from "@intx/log";

// createGranolaTools is mocked at the @workbench/tools-granola boundary: this
// test drives poll → per-note fetch → pipeline hand-off with a fake Granola API
// and a fake pipeline, so the source's own wiring (list, get, dedupe delegation)
// is the unit under test.
const listResult: {
  notes: { id: string; title: string; created_at: string }[];
  hasMore?: boolean;
  cursor?: string;
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
/** When set, overrides `listResult` — a per-cursor page sequence for the
 * multi-page-per-tick tests. Keyed on the incoming `cursor` arg (`undefined`
 * for the first page). */
let pagedResults: Map<
  string | undefined,
  typeof listResult & Record<string, unknown>
> | null = null;
mock.module("@workbench/tools-granola", () => ({
  createGranolaTools: () => [
    {
      kind: "string",
      definition: { name: "granola_list_notes" },
      handler: async (args: Record<string, unknown>) => {
        lastListArgs = args;
        if (pagedResults !== null) {
          const page = pagedResults.get(args.cursor as string | undefined);
          if (!page)
            throw new Error(
              `no fixture page for cursor ${args.cursor as string}`,
            );
          return JSON.stringify(page);
        }
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

  test("a full, limit-capped page advances nextCursor to the max processed created_at (no livelock)", async () => {
    const { pipeline } = fakePipeline();
    const source = createGranolaWorkspaceInboxSource({ pipeline });
    const since = new Date("2026-06-30T00:00:00Z");
    const result = await source.handle(
      makeCtx({ cutoff: since, perSourceLimit: 2 }),
    );
    // note-2 (the later of the two processed notes) is the new floor, not
    // `since` — pinning at `since` would re-issue the identical query forever
    // under sustained overflow.
    expect(result).toEqual({ nextCursor: new Date("2026-07-02T00:00:00Z") });
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

  test("prefers the list response's hasMore signal over the length heuristic, still advancing to max created_at", async () => {
    listResult.hasMore = true;
    try {
      const { pipeline } = fakePipeline();
      const source = createGranolaWorkspaceInboxSource({ pipeline });
      const since = new Date("2026-06-30T00:00:00Z");
      // perSourceLimit is well above notes.length, so the length heuristic
      // alone would say "not truncated" — hasMore must override it.
      const result = await source.handle(
        makeCtx({ cutoff: since, perSourceLimit: 25 }),
      );
      expect(result).toEqual({ nextCursor: new Date("2026-07-02T00:00:00Z") });
    } finally {
      delete listResult.hasMore;
    }
  });

  test("walks multiple list pages within one tick via the response cursor, bounded by MAX_PAGES_PER_TICK", async () => {
    fullNotes["note-3"] = { id: "note-3", title: "Page 2 note" };
    fullNotes["note-4"] = { id: "note-4", title: "Page 3 note" };
    pagedResults = new Map([
      [
        undefined,
        {
          notes: [
            {
              id: "note-1",
              title: "Discovery",
              created_at: "2026-07-01T00:00:00Z",
            },
          ],
          hasMore: true,
          cursor: "page-2",
        },
      ],
      [
        "page-2",
        {
          notes: [
            {
              id: "note-3",
              title: "Page 2 note",
              created_at: "2026-07-02T00:00:00Z",
            },
          ],
          hasMore: true,
          cursor: "page-3",
        },
      ],
      [
        "page-3",
        {
          notes: [
            {
              id: "note-4",
              title: "Page 3 note",
              created_at: "2026-07-03T00:00:00Z",
            },
          ],
          hasMore: false,
        },
      ],
    ]);
    try {
      const { pipeline, calls } = fakePipeline();
      const source = createGranolaWorkspaceInboxSource({ pipeline });
      const result = await source.handle(
        makeCtx({
          cutoff: new Date("2026-06-30T00:00:00Z"),
          perSourceLimit: 1,
        }),
      );
      // All three pages are drained within the single tick call.
      expect(calls.map((c) => c.note.id)).toEqual([
        "note-1",
        "note-3",
        "note-4",
      ]);
      // The final page reported hasMore: false, so the tick is authoritative
      // and the cursor is free to advance to the tick start (undefined here).
      expect(result).toBeUndefined();
    } finally {
      pagedResults = null;
    }
  });

  test("bounds the per-tick page walk at MAX_PAGES_PER_TICK, then advances to the max processed created_at (sustained overflow doesn't livelock)", async () => {
    fullNotes["note-p1"] = { id: "note-p1", title: "p1" };
    fullNotes["note-p2"] = { id: "note-p2", title: "p2" };
    fullNotes["note-p3"] = { id: "note-p3", title: "p3" };
    fullNotes["note-p4"] = { id: "note-p4", title: "p4" };
    const page = (n: number, cursor?: string) => ({
      notes: [
        {
          id: `note-p${n}`,
          title: `p${n}`,
          created_at: `2026-07-0${n}T00:00:00Z`,
        },
      ],
      hasMore: true,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    pagedResults = new Map([
      [undefined, page(1, "c2")],
      ["c2", page(2, "c3")],
      ["c3", page(3, "c4")],
      ["c4", page(4, "c5")], // a 5th page exists, but MAX_PAGES_PER_TICK caps the walk at 4
    ]);
    try {
      const { pipeline, calls } = fakePipeline();
      const source = createGranolaWorkspaceInboxSource({ pipeline });
      const result = await source.handle(
        makeCtx({
          cutoff: new Date("2026-06-30T00:00:00Z"),
          perSourceLimit: 1,
        }),
      );
      expect(calls.map((c) => c.note.id)).toEqual([
        "note-p1",
        "note-p2",
        "note-p3",
        "note-p4",
      ]);
      // Still truncated after 4 pages (hasMore stayed true) — advance to the
      // newest processed note rather than looping forever within the tick.
      expect(result).toEqual({ nextCursor: new Date("2026-07-04T00:00:00Z") });
    } finally {
      pagedResults = null;
    }
  });

  test("sustained overflow across ticks (no page cursor) strictly advances the cursor tick over tick — no livelock, no lost items", async () => {
    fullNotes["note-a"] = { id: "note-a", title: "a" };
    fullNotes["note-b"] = { id: "note-b", title: "b" };
    fullNotes["note-c"] = { id: "note-c", title: "c" };
    fullNotes["note-d"] = { id: "note-d", title: "d" };
    fullNotes["note-e"] = { id: "note-e", title: "e" };
    fullNotes["note-f"] = { id: "note-f", title: "f" };
    // Three consecutive full pages, each with distinct timestamps, and no
    // page cursor at all — simulates an API that only supports the
    // createdAfter window, under sustained overflow (>= perSourceLimit new
    // items every tick).
    const pages: Record<string, { id: string; created_at: string }[]> = {
      "2026-07-01T00:00:00.000Z": [
        { id: "note-a", created_at: "2026-07-01T00:00:00Z" },
        { id: "note-b", created_at: "2026-07-01T00:01:00Z" },
      ],
      "2026-07-01T00:01:00.000Z": [
        { id: "note-c", created_at: "2026-07-01T00:02:00Z" },
        { id: "note-d", created_at: "2026-07-01T00:03:00Z" },
      ],
      "2026-07-01T00:03:00.000Z": [
        { id: "note-e", created_at: "2026-07-01T00:04:00Z" },
        { id: "note-f", created_at: "2026-07-01T00:05:00Z" },
      ],
    };
    const { pipeline, calls } = fakePipeline();
    const source = createGranolaWorkspaceInboxSource({ pipeline });
    let lastPollAt: Date | undefined;
    const cutoff = new Date("2026-07-01T00:00:00Z");
    const cursors: Date[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const since = lastPollAt && lastPollAt > cutoff ? lastPollAt : cutoff;
      const page = pages[since.toISOString()];
      if (!page)
        throw new Error(`no fixture page for since ${since.toISOString()}`);
      listResult.notes = page.map((n) => ({ ...n, title: n.id }));
      const result = await source.handle(
        makeCtx({
          cutoff,
          ...(lastPollAt !== undefined ? { lastPollAt } : {}),
          perSourceLimit: 2,
        }),
      );
      expect(result?.nextCursor).toBeDefined();
      const next = result?.nextCursor as Date;
      cursors.push(next);
      lastPollAt = next;
    }
    // Strictly advancing across ticks — no livelock.
    expect(cursors[1]?.getTime()).toBeGreaterThan(cursors[0]?.getTime() ?? 0);
    expect(cursors[2]?.getTime()).toBeGreaterThan(cursors[1]?.getTime() ?? 0);
    // Every item across the three full pages was actually processed — no
    // lost items given the fetcher honestly returns the window content.
    expect(calls.map((c) => c.note.id)).toEqual([
      "note-a",
      "note-b",
      "note-c",
      "note-d",
      "note-e",
      "note-f",
    ]);
  });
});
