import { describe, expect, mock, test } from "bun:test";
import { getLogger } from "@intx/log";

// createGranolaTools is mocked at the @workbench/tools-granola boundary: this
// test drives poll → skip-or-start with a fake Granola list API and a fake
// artifact-existence check + run starter, so the source's own wiring (list,
// skip-if-processed, direct run start) is the unit under test. CL-4213: the
// source no longer enqueues onto a work-unit-backed queue — it checks
// artifact sourceRef directly and starts the workflow run itself.
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
let lastListArgs: Record<string, unknown> | null = null;
/** When set, overrides `listResult` — a per-cursor page sequence for the
 * multi-page-per-tick tests. Keyed on the incoming `cursor` arg (`undefined`
 * for the first page). */
let pagedResults: Map<
  string | undefined,
  typeof listResult & Record<string, unknown>
> | null = null;
let getToolCalled = false;
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
      handler: async () => {
        // The tick MUST NOT call the get-note tool — that fetch (and the LLM
        // turn it feeds) happens inside the deployed workflow run, not here.
        getToolCalled = true;
        throw new Error("granola_get_note must not be called on the tick");
      },
    },
  ],
}));

let processedSourceRefFixture = new Set<string>();
mock.module("../granola-call-artifacts", () => ({
  granolaCallArtifactsProcessed: async (
    _db: unknown,
    _tenantId: string,
    noteId: string,
  ) => processedSourceRefFixture.has(noteId),
}));

const { createGranolaWorkspaceInboxSource, GRANOLA_WORKSPACE_SOURCE_KEY } =
  await import("./granola-workspace");
import type { WorkspaceInboxSourceContext } from "../inbox-source-registry";
import type { StartRunInput, StartRunResult } from "../workflow-run-starter";

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

function fakeDeps(): {
  db: never;
  startRun: (args: StartRunInput) => Promise<StartRunResult>;
  started: string[];
} {
  const started: string[] = [];
  const startRun = async (args: StartRunInput): Promise<StartRunResult> => {
    started.push(args.input.noteId as string);
    return {
      ok: true,
      deploymentId: "dep-1",
      runId: `run-${args.input.noteId}`,
    };
  };
  return { db: {} as never, startRun, started };
}

describe("granola workspace inbox source", () => {
  test("has the workspace scope and the granola provider key", () => {
    const { db, startRun } = fakeDeps();
    const source = createGranolaWorkspaceInboxSource({ db, startRun });
    expect(source.scope).toBe("workspace");
    // Key MUST equal the tenant-credential provider name resolved by the core.
    expect(source.key).toBe(GRANOLA_WORKSPACE_SOURCE_KEY);
    expect(source.key).toBe("granola");
  });

  test("lists notes since cutoff and starts a run for each — no transcript fetch, no LLM turn on the tick", async () => {
    getToolCalled = false;
    processedSourceRefFixture = new Set();
    const { db, startRun, started } = fakeDeps();
    const source = createGranolaWorkspaceInboxSource({ db, startRun });

    await source.handle(makeCtx());

    expect(lastListArgs?.createdAfter).toBe("2026-06-30T00:00:00.000Z");
    expect(started).toEqual(["note-1", "note-2"]);
    expect(getToolCalled).toBe(false);
  });

  test("skips a note whose three artifacts already exist — no run started", async () => {
    processedSourceRefFixture = new Set(["note-1"]);
    const { db, startRun, started } = fakeDeps();
    const source = createGranolaWorkspaceInboxSource({ db, startRun });

    await source.handle(makeCtx());

    expect(started).toEqual(["note-2"]);
  });

  test("uses the later of cutoff and lastPollAt as the fetch floor", async () => {
    processedSourceRefFixture = new Set();
    const { db, startRun } = fakeDeps();
    const source = createGranolaWorkspaceInboxSource({ db, startRun });
    await source.handle(
      makeCtx({ lastPollAt: new Date("2026-07-05T00:00:00Z") }),
    );
    expect(lastListArgs?.createdAfter).toBe("2026-07-05T00:00:00.000Z");
  });

  test("a failed start run does not throw — the tick continues to the next note", async () => {
    processedSourceRefFixture = new Set();
    const { db } = fakeDeps();
    const attempted: string[] = [];
    const startRun = async (args: StartRunInput): Promise<StartRunResult> => {
      attempted.push(args.input.noteId as string);
      if (args.input.noteId === "note-1") {
        return { ok: false, reason: "provision_failed", message: "boom" };
      }
      return { ok: true, deploymentId: "dep-1", runId: "run-2" };
    };
    const source = createGranolaWorkspaceInboxSource({ db, startRun });
    await source.handle(makeCtx());
    expect(attempted).toEqual(["note-1", "note-2"]);
  });

  test("a member-scope context is ignored (workspace source only runs workspace ticks)", async () => {
    const { db, startRun, started } = fakeDeps();
    const source = createGranolaWorkspaceInboxSource({ db, startRun });
    await source.handle({ scope: "member" } as never);
    expect(started).toEqual([]);
  });

  test("a full, limit-capped page advances nextCursor to the max processed created_at (no livelock)", async () => {
    processedSourceRefFixture = new Set();
    const { db, startRun } = fakeDeps();
    const source = createGranolaWorkspaceInboxSource({ db, startRun });
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
    processedSourceRefFixture = new Set();
    const { db, startRun } = fakeDeps();
    const source = createGranolaWorkspaceInboxSource({ db, startRun });
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
    processedSourceRefFixture = new Set();
    try {
      const { db, startRun } = fakeDeps();
      const source = createGranolaWorkspaceInboxSource({ db, startRun });
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
    processedSourceRefFixture = new Set();
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
      const { db, startRun, started } = fakeDeps();
      const source = createGranolaWorkspaceInboxSource({ db, startRun });
      const result = await source.handle(
        makeCtx({
          cutoff: new Date("2026-06-30T00:00:00Z"),
          perSourceLimit: 1,
        }),
      );
      // All three pages are drained within the single tick call.
      expect(started).toEqual(["note-1", "note-3", "note-4"]);
      // The final page reported hasMore: false, so the tick is authoritative
      // and the cursor is free to advance to the tick start (undefined here).
      expect(result).toBeUndefined();
    } finally {
      pagedResults = null;
    }
  });

  test("bounds the per-tick page walk at MAX_PAGES_PER_TICK, then advances to the max processed created_at (sustained overflow doesn't livelock)", async () => {
    processedSourceRefFixture = new Set();
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
      const { db, startRun, started } = fakeDeps();
      const source = createGranolaWorkspaceInboxSource({ db, startRun });
      const result = await source.handle(
        makeCtx({
          cutoff: new Date("2026-06-30T00:00:00Z"),
          perSourceLimit: 1,
        }),
      );
      expect(started).toEqual(["note-p1", "note-p2", "note-p3", "note-p4"]);
      // Still truncated after 4 pages (hasMore stayed true) — advance to the
      // newest processed note rather than looping forever within the tick.
      expect(result).toEqual({ nextCursor: new Date("2026-07-04T00:00:00Z") });
    } finally {
      pagedResults = null;
    }
  });

  test("sustained overflow across ticks (no page cursor) strictly advances the cursor tick over tick — no livelock, no lost items", async () => {
    processedSourceRefFixture = new Set();
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
    const { db, startRun, started } = fakeDeps();
    const source = createGranolaWorkspaceInboxSource({ db, startRun });
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
    // Every item across the three full pages was actually run — no lost
    // items given the fetcher honestly returns the window content.
    expect(started).toEqual([
      "note-a",
      "note-b",
      "note-c",
      "note-d",
      "note-e",
      "note-f",
    ]);
  });
});
