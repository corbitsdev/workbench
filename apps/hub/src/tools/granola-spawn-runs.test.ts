import { beforeEach, describe, expect, it, mock } from "bun:test";

// Mock at the true module boundaries: the run starter (so no session/provision
// machinery is exercised) and the ancestor-chain walk. The db fake below only
// serves the already-processed artifact lookup.
const startCalls: Record<string, unknown>[] = [];
let startResult: (opts: Record<string, unknown>) => Record<string, unknown>;
// resolveDeployment is the SAME resolver the real start path uses (run-exec);
// the tool reuses it rather than hand-rolling a second published-kind query,
// so the mock controls both from one module boundary.
let childKindResolved = true;
mock.module("../workflow-executor/run-exec", () => ({
  startWorkflowRun: async (
    _deps: unknown,
    opts: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    startCalls.push(opts);
    return startResult(opts);
  },
  resolveDeployment: async (
    _db: unknown,
    _chain: readonly string[],
    kind: string,
  ) =>
    childKindResolved && kind === "process-granola-call"
      ? { deploymentId: "dep-pub", tenantId: "t-1", principalId: "p-pub" }
      : null,
}));
import * as intxDb from "@intx/db";
mock.module("@intx/db", () => ({
  ...intxDb,
  getAncestorChain: async () => ["t-1"],
}));

const { GRANOLA_SPAWN_HUB_TOOLS } = await import("./granola-spawn-runs");

type ToolContext = Parameters<
  (typeof GRANOLA_SPAWN_HUB_TOOLS)["granola_spawn_call_runs"]["createTools"]
>[0];

// Same string-walk trick used for the artifact fake below: the drizzle
// condition passed to findFirst/findMany is an opaque (cyclic) SQL object, so
// match by walking it for string leaves rather than parsing its shape.
function conditionStrings(where: unknown): string[] {
  const strings: string[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) walk(child);
  };
  walk(where);
  return strings;
}

function makeContext(
  processedSourceRefs: string[],
  options: { childKindPublished?: boolean } = {},
): ToolContext {
  childKindResolved = options.childKindPublished ?? true;
  return {
    db: {
      query: {
        artifact: {
          findFirst: async (opts: {
            where: unknown;
          }): Promise<{ id: string } | undefined> => {
            const strings = conditionStrings(opts.where);
            return processedSourceRefs.some((ref) => strings.includes(ref))
              ? { id: "art-1" }
              : undefined;
          },
        },
      },
    },
    tenantId: "t-1",
    principalId: "prn-creator",
    agentId: "a-1",
    sessionId: "s-1",
    sessionService: {} as never,
    cryptoProvider: {} as never,
    deploymentDomain: "workbench.example",
    provisionRunDeployment: (async () => ({ deploymentId: "dep-1" })) as never,
    resolveUserIdentity: (async () => ({
      userAddress: "u@example.com",
      userRefId: "prn-creator",
    })) as never,
  } as unknown as ToolContext;
}

function spawnHandler(context: ToolContext) {
  const tools =
    GRANOLA_SPAWN_HUB_TOOLS.granola_spawn_call_runs.createTools(context);
  const tool = tools[0];
  if (!tool || tool.kind !== "string") throw new Error("expected string tool");
  return tool.handler;
}

const SIGNAL = new AbortController().signal;

function listContent(ids: string[]): string {
  return JSON.stringify({
    notes: ids.map((id) => ({ id, title: `Call ${id}` })),
  });
}

beforeEach(() => {
  startCalls.length = 0;
  startResult = () => ({
    ok: true,
    state: { runId: `run-${startCalls.length}` },
  });
});

describe("granola_spawn_call_runs", () => {
  it("starts one process-granola-call run per unprocessed note, attributed to the caller", async () => {
    const handler = spawnHandler(makeContext([]));
    const result = JSON.parse(
      await handler({ content: listContent(["n1", "n2"]) }, SIGNAL),
    ) as { spawned: unknown[]; skippedAlreadyProcessed: number };

    expect(result.spawned).toHaveLength(2);
    expect(result.skippedAlreadyProcessed).toBe(0);
    expect(startCalls).toHaveLength(2);
    expect(startCalls[0]).toMatchObject({
      kind: "process-granola-call",
      principalId: "prn-creator",
      input: { noteId: "n1" },
      originConversationId: null,
    });
  });

  it("skips notes that already have a call-notes artifact — a quiet call spawns nothing", async () => {
    const handler = spawnHandler(
      makeContext(["granola-call-note-n1", "granola-call-note-n2"]),
    );
    const result = JSON.parse(
      await handler({ content: listContent(["n1", "n2"]) }, SIGNAL),
    ) as { spawned: unknown[]; skippedAlreadyProcessed: number };

    expect(result.spawned).toHaveLength(0);
    expect(result.skippedAlreadyProcessed).toBe(2);
    expect(startCalls).toHaveLength(0);
  });

  it("caps considered notes at maxCalls, accepting text or numeric values", async () => {
    const handler = spawnHandler(makeContext([]));
    const asText = JSON.parse(
      await handler(
        { content: listContent(["a", "b", "c"]), maxCalls: "2" },
        SIGNAL,
      ),
    ) as { considered: number };
    expect(asText.considered).toBe(2);

    startCalls.length = 0;
    const asNumber = JSON.parse(
      await handler(
        { content: listContent(["a", "b", "c"]), maxCalls: 1 },
        SIGNAL,
      ),
    ) as { considered: number };
    expect(asNumber.considered).toBe(1);
  });

  it("one failed start never aborts the batch — it is reported and the rest spawn", async () => {
    startResult = (opts) =>
      (opts.input as { noteId: string }).noteId === "bad"
        ? { ok: false, error: "boom" }
        : { ok: true, state: { runId: "run-good" } };
    const handler = spawnHandler(makeContext([]));
    const result = JSON.parse(
      await handler({ content: listContent(["bad", "good"]) }, SIGNAL),
    ) as { spawned: unknown[]; failed: { noteId: string }[] };

    expect(result.spawned).toHaveLength(1);
    expect(result.failed).toEqual([{ noteId: "bad", error: "boom" }]);
  });

  it("rejects non-JSON content and unrecognized list shapes loudly", async () => {
    const handler = spawnHandler(makeContext([]));
    await expect(handler({ content: "not json" }, SIGNAL)).rejects.toThrow(
      "not valid JSON",
    );
    await expect(
      handler({ content: JSON.stringify({ nope: true }) }, SIGNAL),
    ).rejects.toThrow("notes array");
  });

  it("rejects loudly when the child kind has no published definition in the tenant chain", async () => {
    const handler = spawnHandler(
      makeContext([], { childKindPublished: false }),
    );
    await expect(
      handler({ content: listContent(["n1"]) }, SIGNAL),
    ).rejects.toThrow("process-granola-call");
    expect(startCalls).toHaveLength(0);
  });

  it("rejects loudly when every spawn in the batch fails not_found, even past the up-front publish check", async () => {
    startResult = () => ({
      ok: false,
      status: 404,
      error: 'no deployed workflow of kind "process-granola-call"',
    });
    const handler = spawnHandler(makeContext([]));
    await expect(
      handler({ content: listContent(["n1", "n2"]) }, SIGNAL),
    ).rejects.toThrow("process-granola-call");
  });
});
