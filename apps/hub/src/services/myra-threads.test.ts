import { beforeEach, describe, expect, it, mock } from "bun:test";

// --- Module-boundary mocks for the title-generation inference path ---

let lastCreateEventCollectorConfig: {
  instanceId: string;
  tenantId: string;
  sessionId: string;
} | null = null;
let collectorEvents: { type: string }[] = [];
let agentReply = "Pricing Deep Dive";
let agentShouldThrow = false;
// When true, the agent's send() never resolves on its own; it settles only when
// close() is invoked — models a turn wedged in the reactor/send path (CL-2866).
let agentSendHangs = false;
// When true, the turn's inference cycle ends in an unrecoverable
// inference.error, but send() still resolves with the director's
// SDK-synthesized apology reply (agentReply) as if it were real output
// (CL-3870) — models a title-turn-local inference failure (e.g. 402).
let agentInferenceErrors = false;
// When true, close() never resolves — models the reported wedge, a hang in
// post-inference teardown (close / audit-commit) that abort cannot unblock.
let agentCloseHangs = false;
let agentCloseCalls = 0;
let titleTurnTimeoutMs = 45_000;
let lastIsogitDir: string | null = null;
let lastIsogitGcPolicy: unknown = null;
let isogitDirs: string[] = [];

function resetTitleMocks() {
  lastCreateEventCollectorConfig = null;
  collectorEvents = [];
  agentReply = "Pricing Deep Dive";
  agentShouldThrow = false;
  agentSendHangs = false;
  agentInferenceErrors = false;
  agentCloseHangs = false;
  agentCloseCalls = 0;
  titleTurnTimeoutMs = 45_000;
  lastIsogitDir = null;
  lastIsogitGcPolicy = null;
  isogitDirs = [];
  analyticsMock.onLocalInferenceEvent.mockClear();
  ancestorChainResult = ["tn-global"];
}

const analyticsMock = {
  onAgentEvent: mock((_event: unknown) => Promise.resolve()),
  onLocalInferenceEvent: mock((_event: unknown) => Promise.resolve()),
};
// biome-ignore lint/suspicious/noExplicitAny: structural analytics deps for the title fn
const titleDeps = { analytics: analyticsMock } as any;

mock.module("@workbench/storage-isogit", () => ({
  createIsogitStore: mock((dir: string, _signer?: unknown, gc?: unknown) => {
    lastIsogitDir = dir;
    lastIsogitGcPolicy = gc ?? null;
    isogitDirs.push(dir);
    return Promise.resolve({});
  }),
}));

mock.module("@workbench/event-collector", () => ({
  createEventCollector: mock(
    (config: {
      instanceId: string;
      tenantId: string;
      sessionId: string;
      onTurnFinalized?: (turn: unknown) => void;
    }) => {
      lastCreateEventCollectorConfig = {
        instanceId: config.instanceId,
        tenantId: config.tenantId,
        sessionId: config.sessionId,
      };
      return {
        onEvent: mock((event: { type: string }) => {
          collectorEvents.push(event);
          if (event.type === "inference.done" && config.onTurnFinalized) {
            config.onTurnFinalized({
              turnId: "t1",
              status: "completed",
              text: agentReply,
              hadReply: true,
              hadError: false,
              errors: [],
              toolCalls: [],
              toolErrors: [],
              reasoning: "",
            });
          }
          return Promise.resolve();
        }),
        abandon: mock(() => Promise.resolve()),
        getAccumulatedText: () => agentReply,
        getCurrentTurnId: () => null,
        getLastTurnId: () => "t1",
      };
    },
  ),
}));

mock.module("@intx/agent", () => ({
  defineAgent: mock((def: unknown) => def),
  createDefaultDirectorRegistry: mock(() => ({})),
  createAgent: mock(() => {
    let rejectHungSend: ((err: unknown) => void) | null = null;
    return Promise.resolve({
      async *stream() {
        yield { type: "inference.start", data: { model: "m" } };
        if (agentInferenceErrors) {
          yield {
            type: "inference.error",
            seq: 2,
            data: {
              error: { category: "fatal", message: "insufficient balance" },
              partial: { text: "" },
            },
          };
        } else {
          // Schema-valid inference.done (seq + usage + source) so the real
          // parseInferenceEvent in runTrackedOneShot accepts it and the title
          // path's analytics forwarding actually fires (CL-2887 seam coverage).
          yield {
            type: "inference.done",
            seq: 2,
            data: {
              turn: {
                role: "assistant",
                content: [],
                model: "gpt-4o",
                timestamp: 0,
              },
              usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                thinking: 0,
              },
              source: {
                sourceId: "off_1",
                provider: "openai-compatible",
                model: "gpt-4o",
              },
            },
          };
        }
        yield { type: "message.received", data: {} };
      },
      send: mock(() => {
        if (agentShouldThrow)
          return Promise.reject(new Error("inference boom"));
        if (agentSendHangs)
          return new Promise((_, reject) => {
            rejectHungSend = reject;
          });
        return Promise.resolve({ reply: agentReply });
      }),
      close: mock(() => {
        agentCloseCalls += 1;
        // close() drains the send queue with AgentClosedError in the real agent;
        // mirror that so a hung send() rejects when the turn is aborted.
        rejectHungSend?.(new Error("AgentClosedError"));
        // Real close() releases the workdir lock only after its own bounded
        // shutdown wait; model a wedge in that teardown as a never-settling
        // close so the deadline — not close — must bound the caller (CL-2866).
        if (agentCloseHangs) return new Promise<void>(() => {});
        return Promise.resolve();
      }),
    });
  }),
}));

const resolveCredentialRequirementMock = mock(() => Promise.resolve(null));
// Chain returned by getAncestorChain — [tenant, ...ancestors, root]. Default is a
// single-tenant chain (active == root); per-test overrides exercise sub-tenants.
let ancestorChainResult: string[] = ["tn-global"];
const getAncestorChainMock = mock((_db: unknown, tenantId: string) =>
  Promise.resolve(
    ancestorChainResult.length > 0 ? ancestorChainResult : [tenantId],
  ),
);
mock.module("@intx/db", () => ({
  schema: {
    agent: { tenantId: "agent.tenantId", name: "agent.name" },
    agentInstance: {},
    agentSession: {},
    principal: {},
    grant: {},
    inferenceTurn: { instanceId: "inferenceTurn.instanceId" },
  },
  resolveCredentialRequirement: resolveCredentialRequirementMock,
  getAncestorChain: getAncestorChainMock,
}));

mock.module("../config", () => ({
  getConfig: () => ({
    hub: {
      dataDir: "/tmp/myra-title-test",
      agentGc: { packThreshold: 16, looseThreshold: 512, warnBytes: 1024 },
      myraTitleTurnTimeoutMs: titleTurnTimeoutMs,
    },
    rootTenant: { slug: "global", domain: "global.test" },
  }),
}));

let launchShouldThrow: unknown = null;
const launchAgentSessionMock = mock(() => {
  if (launchShouldThrow !== null) return Promise.reject(launchShouldThrow);
  return Promise.resolve({ address: "a", sessionId: "s" });
});
mock.module("./agent-provisioning", () => ({
  resolveInstanceSourcesFromDefinition: mock(() =>
    Promise.resolve({
      ok: true,
      sources: [
        {
          id: "ofr_1",
          provider: "openai-compatible",
          baseURL: "https://llm.example/v1",
          apiKey: "sk-myra",
          model: "gpt-4o",
        },
      ],
    }),
  ),
  launchAgentSession: launchAgentSessionMock,
  describeLaunchError: (err: unknown) => ({
    phase: null,
    detail: err instanceof Error ? err.message : String(err),
    leakedAgent:
      err instanceof Error && (err as { leakedAgent?: boolean }).leakedAgent
        ? true
        : false,
  }),
  isAgentAlreadyExistsError: (err: unknown) =>
    err instanceof Error &&
    err.message.includes("Agent already exists for address"),
}));

// CL-2517: mock the tenant-provisioning boundary so createMyraThread's reseed
// call is a controllable spy (the minimal create-db mock has no agent.findFirst,
// so the real helper would throw). lookupMember is only used by
// resolveMyraThreadContext, which these service-fn tests never hit — null is safe.
let reseedResult: { reseeded: boolean; agentId: string | null } = {
  reseeded: false,
  agentId: null,
};
const reseedSpy = mock(() => Promise.resolve(reseedResult));
mock.module("../lib/tenant-provisioning", () => ({
  lookupMember: mock(() => Promise.resolve(null)),
  reseedAgentTemplateIfStale: reseedSpy,
}));

// CL-3824: launch soft-nulls via resolveLaunchableMyraVariant. Unit tests treat
// every catalog model as launchable so binding still follows stored prefs.
mock.module("./myra-variant-availability", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- bun mock.module
  const myra = require("@workbench/myra") as typeof import("@workbench/myra");
  return {
    resolveLaunchableMyraVariant: mock(
      async (
        _db: unknown,
        _tenantId: string,
        kind: "chat" | "triage",
        selectedId: string | null | undefined,
      ) => myra.resolveMyraVariant(kind, selectedId),
    ),
    listAvailableMyraVariants: mock(async () => myra.listMyraVariants()),
    isMyraVariantAvailableForTenant: mock(async () => true),
    softNullUnavailableVariantSelections: mock(
      async (
        _db: unknown,
        _tenantId: string,
        prefs: { chat: string | null; triage: string | null },
      ) => prefs,
    ),
  };
});

import type { InferenceEvent } from "@intx/types/runtime";
import { createAnalyticsSubscriber } from "@workbench/analytics";
import { desc, eq } from "drizzle-orm";
import { memberAgentInstance } from "../db/schema";
import {
  createMyraThread,
  deleteMyraThread,
  generateMyraThreadTitle,
  listMyraThreads,
  recordMyraThreadActivity,
  renameMyraThread,
} from "./myra-threads";

describe("createMyraThread", () => {
  beforeEach(() => {
    ancestorChainResult = ["tn-global"];
    reseedResult = { reseeded: false, agentId: null };
    reseedSpy.mockClear();
    launchAgentSessionMock.mockClear();
  });

  function buildCreateDb(opts: {
    transactions: () => void;
    deleted?: unknown[];
    updated?: Record<string, unknown>[];
    inserted?: Record<string, unknown>[];
    agentDefs?: Record<string, unknown>[];
    existingThreads?: Record<string, unknown>[];
    variantPref?: {
      chatVariantId: string | null;
      triageVariantId: string | null;
    } | null;
    /** Whether the anonymous-unused candidate's instance has transcript rows. */
    transcriptExists?: boolean;
    /**
     * FIFO answers for successive instanceHasTranscript calls, in call order:
     * first the reuse-candidate check (if any), then the stale-reap loop in
     * existingThreads order. Takes precedence over `transcriptExists`.
     */
    transcriptQueue?: boolean[];
  }) {
    const transcriptQueue = [...(opts.transcriptQueue ?? [])];
    const agentDefs = opts.agentDefs ?? [
      {
        id: "agt-myra",
        tenantId: "tn-global",
        systemPrompt: "You are Myra.",
      },
    ];
    return {
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            opts.updated?.push({ table, values });
            return Promise.resolve(undefined);
          },
        }),
      }),
      query: {
        agent: {
          findMany: mock(() => Promise.resolve(agentDefs)),
        },
        memberAgentInstance: {
          findMany: mock(() => Promise.resolve(opts.existingThreads ?? [])),
        },
        agentInstance: {
          findFirst: mock(() =>
            Promise.resolve({ principalId: "prn-stale-instance" }),
          ),
        },
        myraVariantPreference: {
          findFirst: mock(() => Promise.resolve(opts.variantPref ?? undefined)),
        },
        inferenceTurn: {
          findFirst: mock(() => {
            if (opts.transcriptQueue !== undefined) {
              const hasTranscript = transcriptQueue.shift() ?? false;
              return Promise.resolve(
                hasTranscript ? { id: "turn-1" } : undefined,
              );
            }
            return Promise.resolve(
              opts.transcriptExists ? { id: "turn-1" } : undefined,
            );
          }),
        },
      },
      transaction: mock(async (fn: (tx: unknown) => Promise<void>) => {
        opts.transactions();
        await fn({
          insert: () => ({
            values: (values: Record<string, unknown>) => {
              opts.inserted?.push(values);
              return Promise.resolve(undefined);
            },
          }),
          delete: (table: unknown) => {
            opts.deleted?.push(table);
            return { where: () => Promise.resolve(undefined) };
          },
        });
      }),
    };
  }

  it("binds a member's selected chat variant definition, skipping the canonical reseed", async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = buildCreateDb({
      transactions: () => {},
      inserted,
      variantPref: { chatVariantId: "myra-opus-4-8", triageVariantId: null },
      agentDefs: [
        {
          id: "agt-myra-opus",
          tenantId: "tn-global",
          systemPrompt: "You are Myra (Opus).",
        },
      ],
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "global.test",
      memberPrincipalId: "prn-member",
    });

    expect(result.created).toBe(true);
    // The variant path resolves its own seeded definition and does NOT run the
    // canonical `myra`-template reseed.
    expect(reseedSpy).not.toHaveBeenCalled();
    const instanceInsert = inserted.find((v) => "address" in v);
    expect(instanceInsert?.agentId).toBe("agt-myra-opus");
    // The thread stays a `myra`-templateKey thread so it lists as normal chat.
    const mappingInsert = inserted.find((v) => "templateKey" in v);
    expect(mappingInsert?.templateKey).toBe("myra");
  });

  it("uses the canonical definition (and reseed path) when no preference is set", async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = buildCreateDb({
      transactions: () => {},
      inserted,
      variantPref: null,
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "global.test",
      memberPrincipalId: "prn-member",
    });

    // Canonical fallback runs the CL-2517 staleness reseed for the tenant's own def.
    expect(reseedSpy).toHaveBeenCalled();
    const instanceInsert = inserted.find((v) => "address" in v);
    expect(instanceInsert?.agentId).toBe("agt-myra");
  });

  it("creates the rows and returns created:true WITHOUT launching a session (CL-2803)", async () => {
    let txCount = 0;
    const deleted: unknown[] = [];
    const inserted: Record<string, unknown>[] = [];
    const db = buildCreateDb({
      transactions: () => (txCount += 1),
      deleted,
      inserted,
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "global.test",
      memberPrincipalId: "prn-member",
    });

    expect(result.created).toBe(true);
    // First thread gets the default "Chat" label; a real, non-empty instance id.
    expect(result.thread.label).toBe("Chat");
    expect(result.thread.instanceId.length).toBeGreaterThan(0);
    // A fresh thread has never been used — clients keep it out of the sidebar
    // until its first message lands (CL-3749).
    expect(result.thread.firstMessageAt).toBeNull();
    // The instance row is persisted as `deployed` (no session yet); the chat
    // surface cold-launches it on first open.
    const instanceInsert = inserted.find((v) => "address" in v);
    expect(instanceInsert?.status).toBe("deployed");
    // Lazy provisioning (CL-2803): create MUST NOT launch a session, and MUST
    // NOT run a teardown — only the single create transaction runs.
    expect(launchAgentSessionMock).not.toHaveBeenCalled();
    expect(txCount).toBe(1);
    expect(deleted).toHaveLength(0);
  });

  // CL-3749: unused threads are hidden from every list, so repeated "+ New
  // chat" clicks must not strand invisible rows — an existing never-used
  // thread IS the new chat.
  it("hands back an existing never-used thread instead of creating another", async () => {
    let txCount = 0;
    const db = buildCreateDb({
      transactions: () => (txCount += 1),
      existingThreads: [
        {
          id: "map-used",
          instanceId: "inst-used",
          label: "Pricing",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          lastActivityAt: new Date("2026-01-02T00:00:00Z"),
          firstMessageAt: new Date("2026-01-02T00:00:00Z"),
        },
        {
          id: "map-unused",
          instanceId: "inst-unused",
          agentId: "agt-myra",
          label: "Chat 2",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          lastActivityAt: new Date("2026-01-03T00:00:00Z"),
          firstMessageAt: null,
        },
      ],
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "global.test",
      memberPrincipalId: "prn-member",
    });

    expect(result.created).toBe(false);
    expect(result.thread.id).toBe("map-unused");
    expect(result.thread.instanceId).toBe("inst-unused");
    expect(result.thread.firstMessageAt).toBeNull();
    // No rows written, no session launched — the unused thread is reused as-is.
    expect(txCount).toBe(0);
    expect(launchAgentSessionMock).not.toHaveBeenCalled();
  });

  // Agent-initiated mail (sidecar/WS plane) never stamps firstMessageAt, so a
  // thread with a real transcript can still look "anonymous unused" by the
  // firstMessageAt-null + default-label heuristic. Reusing it would land
  // "+ New chat" on a non-empty conversation.
  it("does not reuse an anonymous-looking unused thread whose instance already has a transcript", async () => {
    let txCount = 0;
    const inserted: Record<string, unknown>[] = [];
    const db = buildCreateDb({
      transactions: () => (txCount += 1),
      inserted,
      transcriptExists: true,
      existingThreads: [
        {
          id: "map-ghost-transcript",
          instanceId: "inst-ghost-transcript",
          agentId: "agt-myra",
          label: "Chat",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          lastActivityAt: new Date("2026-01-03T00:00:00Z"),
          firstMessageAt: null,
        },
      ],
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "global.test",
      memberPrincipalId: "prn-member",
    });

    expect(result.created).toBe(true);
    expect(result.thread.id).not.toBe("map-ghost-transcript");
    const instanceInsert = inserted.find((v) => "address" in v);
    expect(instanceInsert).toBeDefined();
    expect(txCount).toBe(1);
  });

  it("reaps (never reuses) an unused thread deployed against a stale definition", async () => {
    let txCount = 0;
    const deleted: unknown[] = [];
    const db = buildCreateDb({
      transactions: () => (txCount += 1),
      deleted,
      existingThreads: [
        {
          id: "map-stale",
          instanceId: "inst-stale",
          agentId: "agt-myra-old",
          label: "Chat",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          lastActivityAt: new Date("2026-01-03T00:00:00Z"),
          firstMessageAt: null,
        },
      ],
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "global.test",
      memberPrincipalId: "prn-member",
    });

    // A stale-def unused row would hand out an old toolset if reused — and be
    // stranded forever if merely skipped (hidden, unreachable, undeletable).
    // It must be torn down while a fresh thread is created.
    expect(result.created).toBe(true);
    expect(result.thread.id).not.toBe("map-stale");
    expect(deleted.length).toBeGreaterThan(0);
    // Two transactions: the reap teardown and the create.
    expect(txCount).toBe(2);
  });

  // The stale-def reap loop used the same firstMessageAt-null heuristic as the
  // reuse check, with no transcript guard. teardownThreadRows deletes the
  // agentInstance, cascading the inferenceTurn rows — so a thread carrying a
  // WS-plane-only transcript on a since-reseeded def would have its
  // transcript permanently destroyed on the next "+ New chat".
  it("spares a stale-def unused thread that already has a transcript from the reap, while still reaping a genuinely empty one", async () => {
    let txCount = 0;
    const deleted: unknown[] = [];
    const db = buildCreateDb({
      transactions: () => (txCount += 1),
      deleted,
      // Call order: stale-reap loop only (no reuse candidate matches this
      // tenant's current def), in existingThreads order — transcript-bearing
      // row first, then the genuinely empty row.
      transcriptQueue: [true, false],
      existingThreads: [
        {
          id: "map-stale-transcript",
          instanceId: "inst-stale-transcript",
          agentId: "agt-myra-old",
          label: "Chat",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          lastActivityAt: new Date("2026-01-03T00:00:00Z"),
          firstMessageAt: null,
        },
        {
          id: "map-stale-empty",
          instanceId: "inst-stale-empty",
          agentId: "agt-myra-old",
          label: "Chat 2",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          lastActivityAt: new Date("2026-01-03T00:00:00Z"),
          firstMessageAt: null,
        },
      ],
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "global.test",
      memberPrincipalId: "prn-member",
    });

    expect(result.created).toBe(true);
    // teardownThreadRows deletes 5 rows per torn-down thread (grant,
    // memberAgentInstance, agentInstance, agentSession, principal). Exactly 5
    // deletes means only the genuinely empty row was reaped — the
    // transcript-bearing row's 5 rows (and its inferenceTurn cascade) survive.
    expect(deleted).toHaveLength(5);
    // Two transactions: one reap teardown (the empty row only) and the create.
    expect(txCount).toBe(2);
  });

  it("CL-3793: reaps a deepseek-bound blank thread and binds + New Chat to the newly selected Opus variant", async () => {
    // Repro for CL-3793: a member's only existing thread is an anonymous,
    // never-messaged "Chat" bound to the canonical deepseek definition
    // (agt-myra). The member then selects the Opus chat variant and clicks
    // "+ New Chat" (label: undefined). The blank deepseek thread must NOT be
    // handed back — it must be reaped, and the new thread's instance must be
    // bound to the Opus-seeded definition, not the stale deepseek one.
    let txCount = 0;
    const deleted: unknown[] = [];
    const inserted: Record<string, unknown>[] = [];
    const db = buildCreateDb({
      transactions: () => (txCount += 1),
      deleted,
      inserted,
      variantPref: { chatVariantId: "myra-opus-4-8", triageVariantId: null },
      agentDefs: [
        {
          id: "agt-myra-opus",
          tenantId: "tn-global",
          systemPrompt: "You are Myra (Opus).",
        },
      ],
      existingThreads: [
        {
          id: "map-deepseek-blank",
          instanceId: "inst-deepseek-blank",
          agentId: "agt-myra",
          label: "Chat",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          lastActivityAt: new Date("2026-01-03T00:00:00Z"),
          firstMessageAt: null,
        },
      ],
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "global.test",
      memberPrincipalId: "prn-member",
    });

    expect(result.created).toBe(true);
    expect(result.thread.id).not.toBe("map-deepseek-blank");
    // The stale deepseek-bound blank thread is torn down, not reused.
    expect(deleted.length).toBeGreaterThan(0);
    const instanceInsert = inserted.find((v) => "address" in v);
    expect(instanceInsert?.agentId).toBe("agt-myra-opus");
    const mappingInsert = inserted.find((v) => "templateKey" in v);
    expect(mappingInsert?.agentId).toBe("agt-myra-opus");
  });

  it("neither reuses nor reaps a custom-labelled unused thread", async () => {
    let txCount = 0;
    const deleted: unknown[] = [];
    const db = buildCreateDb({
      transactions: () => (txCount += 1),
      deleted,
      existingThreads: [
        {
          id: "map-named",
          instanceId: "inst-named",
          agentId: "agt-myra",
          label: "Quarterly planning",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          lastActivityAt: new Date("2026-01-03T00:00:00Z"),
          firstMessageAt: null,
        },
      ],
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "global.test",
      memberPrincipalId: "prn-member",
    });

    // A named thread carries user intent: "+ New chat" must not consume its
    // identity, and it is never garbage-collected.
    expect(result.created).toBe(true);
    expect(result.thread.id).not.toBe("map-named");
    expect(deleted).toHaveLength(0);
    expect(txCount).toBe(1);
  });

  it("still creates a fresh thread for an explicit label even when an unused thread exists", async () => {
    let txCount = 0;
    const inserted: Record<string, unknown>[] = [];
    const db = buildCreateDb({
      transactions: () => (txCount += 1),
      inserted,
      existingThreads: [
        {
          id: "map-unused",
          instanceId: "inst-unused",
          label: "Chat",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          lastActivityAt: new Date("2026-01-03T00:00:00Z"),
          firstMessageAt: null,
        },
      ],
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "global.test",
      memberPrincipalId: "prn-member",
      label: "Quarterly planning",
    });

    expect(result.created).toBe(true);
    expect(result.thread.label).toBe("Quarterly planning");
    expect(result.thread.id).not.toBe("map-unused");
    expect(txCount).toBe(1);
  });

  it("reseeds the tenant's own def (CL-2517 wiring)", async () => {
    reseedResult = { reseeded: true, agentId: "agt-myra" };
    const db = buildCreateDb({ transactions: () => {} });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "acme.example.com",
      memberPrincipalId: "prn_member",
    });

    expect(reseedSpy).toHaveBeenCalledTimes(1);
    const [, calledTenantId, calledTemplate] = reseedSpy.mock
      .calls[0] as unknown as [unknown, string, { key: string }];
    expect(calledTenantId).toBe("tn-global");
    expect(calledTemplate.key).toBe("myra");
  });

  it("does NOT reseed an inherited (parent-tenant) def — own-def gate (CL-2517/M1)", async () => {
    ancestorChainResult = ["tn-global", "tn-root"];
    const db = buildCreateDb({
      transactions: () => {},
      agentDefs: [
        { id: "agt-root", tenantId: "tn-root", systemPrompt: "You are Myra." },
      ],
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    await createMyraThread(db as any, {
      tenantId: "tn-global",
      tenantDomain: "acme.example.com",
      memberPrincipalId: "prn_member",
    });

    expect(reseedSpy).not.toHaveBeenCalled();
  });
});

describe("createMyraThread (active-workbench attribution)", () => {
  function buildDb(
    inserted: Record<string, unknown>[],
    agentDefs: Record<string, unknown>[],
  ) {
    return {
      query: {
        agent: { findMany: mock(() => Promise.resolve(agentDefs)) },
        memberAgentInstance: { findMany: mock(() => Promise.resolve([])) },
        myraVariantPreference: {
          findFirst: mock(() => Promise.resolve(undefined)),
        },
      },
      transaction: mock(async (fn: (tx: unknown) => Promise<void>) => {
        await fn({
          insert: () => ({
            values: (values: Record<string, unknown>) => {
              inserted.push(values);
              return Promise.resolve(undefined);
            },
          }),
          delete: () => ({ where: () => Promise.resolve(undefined) }),
        });
      }),
    };
  }

  it("creates the instance + mapping in the active child tenant using the root Myra definition", async () => {
    ancestorChainResult = ["tn-child", "tn-root"];
    const inserted: Record<string, unknown>[] = [];
    const db = buildDb(inserted, [
      { id: "agt-root", tenantId: "tn-root", systemPrompt: "You are Myra." },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    await createMyraThread(db as any, {
      tenantId: "tn-child",
      tenantDomain: "child.test",
      memberPrincipalId: "prn-member",
    });

    const instanceInsert = inserted.find((v) => "address" in v);
    expect(instanceInsert?.tenantId).toBe("tn-child");
    expect(instanceInsert?.agentId).toBe("agt-root");
    const mappingInsert = inserted.find((v) => "templateKey" in v);
    expect(mappingInsert?.tenantId).toBe("tn-child");
    expect(mappingInsert?.agentId).toBe("agt-root");
  });

  it("prefers the most-specific definition when the child has its own", async () => {
    ancestorChainResult = ["tn-child", "tn-root"];
    const inserted: Record<string, unknown>[] = [];
    const db = buildDb(inserted, [
      { id: "agt-root", tenantId: "tn-root", systemPrompt: "root" },
      { id: "agt-child", tenantId: "tn-child", systemPrompt: "child" },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    await createMyraThread(db as any, {
      tenantId: "tn-child",
      tenantDomain: "child.test",
      memberPrincipalId: "prn-member",
    });

    const instanceInsert = inserted.find((v) => "address" in v);
    expect(instanceInsert?.agentId).toBe("agt-child");
  });

  it("throws a clear error when no Myra definition exists in the chain", async () => {
    ancestorChainResult = ["tn-child", "tn-root"];
    const db = buildDb([], []);

    let thrown: unknown;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: structural db mock
      await createMyraThread(db as any, {
        tenantId: "tn-child",
        tenantDomain: "child.test",
        memberPrincipalId: "prn-member",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  it("attributes the analytics rollup to the child tenant for a child-tenant instance (subscriber seam)", async () => {
    ancestorChainResult = ["tn-child", "tn-root"];
    const inserted: Record<string, unknown>[] = [];
    const createDb = buildDb(inserted, [
      { id: "agt-root", tenantId: "tn-root", systemPrompt: "You are Myra." },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    await createMyraThread(createDb as any, {
      tenantId: "tn-child",
      tenantDomain: "child.test",
      memberPrincipalId: "prn-member",
    });

    const instanceInsert = inserted.find((v) => "address" in v);
    expect(instanceInsert).toBeDefined();
    // Reconstruct the persisted instance row the subscriber resolves by address.
    const instanceRow: Record<string, unknown> = {
      ...instanceInsert,
      sessionId: "ses_child",
      endedAt: null,
    };

    const rollups: Record<string, unknown>[] = [];
    const subscriberChain = {
      values: mock(() => subscriberChain),
      onConflictDoNothing: mock(() => subscriberChain),
      onConflictDoUpdate: mock(() => Promise.resolve()),
      returning: mock(() => Promise.resolve([{ id: "ane_new" }])),
    };
    let insertCount = 0;
    const analyticsDb = {
      query: {
        agentInstance: { findFirst: mock(() => Promise.resolve(instanceRow)) },
      },
      insert: mock(() => {
        insertCount += 1;
        return {
          values: (v: Record<string, unknown>) => {
            // Second insert is the daily rollup.
            if (insertCount === 2) rollups.push(v);
            return subscriberChain;
          },
        };
      }),
      transaction: mock(
        async (fn: (tx: unknown) => Promise<void>) => await fn(analyticsDb),
      ),
    };

    const subscriber = createAnalyticsSubscriber({ db: analyticsDb as never });
    const inferenceDone: InferenceEvent = {
      type: "inference.done",
      seq: 10,
      data: {
        turn: { role: "assistant", content: [], model: "m", timestamp: 0 },
        usage: {
          input: 100,
          output: 40,
          cacheRead: 1,
          cacheWrite: 2,
          thinking: 3,
        },
        source: { sourceId: "s", provider: "openai-compatible", model: "m" },
      },
    } as InferenceEvent;

    await subscriber.onAgentEvent({
      agentAddress: instanceRow.address as string,
      event: inferenceDone,
    });

    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.tenantId).toBe("tn-child");
    expect(rollups[0]?.inputTokens).toBe(100);
  });
});

describe("generateMyraThreadTitle", () => {
  function buildTitleDb(opts: {
    mappingRow:
      | { id: string; instanceId: string; label: string | null }
      | undefined;
    renamed?: {
      id: string;
      instanceId: string;
      label: string;
      createdAt: Date;
      lastActivityAt: Date;
      firstMessageAt?: Date | null;
    };
  }) {
    const updateReturning = mock(() =>
      Promise.resolve(opts.renamed ? [opts.renamed] : []),
    );
    return {
      query: {
        memberAgentInstance: {
          findFirst: mock(() => Promise.resolve(opts.mappingRow)),
        },
        agent: {
          findMany: mock(() =>
            Promise.resolve([
              { id: "agt", tenantId: "tn-global", modelRequirements: null },
            ]),
          ),
        },
        // runTitleTurn (CL-2162/3b0d4dcc) resolves the instance row to attribute
        // the recorded turn and to FK the durable per-tenant title session.
        agentInstance: {
          findFirst: mock(() =>
            Promise.resolve(
              opts.mappingRow
                ? {
                    id: opts.mappingRow.instanceId,
                    agentId: "agt",
                    principalId: "prn-inst",
                  }
                : undefined,
            ),
          ),
        },
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      // The title session is upserted idempotently before the turn runs.
      insert: mock(() => ({
        values: () => ({ onConflictDoNothing: mock(() => Promise.resolve()) }),
      })),
      update: mock(() => ({
        set: () => ({ where: () => ({ returning: updateReturning }) }),
      })),
    };
  }

  it("titles a default-labelled thread and records the turn under a dedicated bookkeeping instance, never the thread's own instance (CL-3894)", async () => {
    resetTitleMocks();
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat" },
      renamed: {
        id: "map-1",
        instanceId: "inst-1",
        label: "Pricing Deep Dive",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastActivityAt: new Date("2026-01-04T00:00:00Z"),
        firstMessageAt: new Date("2026-01-04T00:00:00Z"),
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "How should we price the enterprise tier?",
    });

    expect(result).toEqual({
      id: "map-1",
      instanceId: "inst-1",
      label: "Pricing Deep Dive",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-04T00:00:00.000Z",
      firstMessageAt: "2026-01-04T00:00:00.000Z",
    });
    // The turn is recorded under a durable, tenant-scoped bookkeeping instance
    // — NEVER the thread's own instanceId. `/turns` (the same route the live
    // chat transcript hydrates from) returns every inference_turn row for an
    // instanceId with no way to tell a title turn from a real reply, so
    // recording it under "inst-1" would render the generated title inline as
    // a stray assistant bubble in the user's own conversation (CL-3894).
    expect(lastCreateEventCollectorConfig?.instanceId).not.toBe("inst-1");
    expect(lastCreateEventCollectorConfig?.instanceId).toBe(
      "ins_myra-title-tn-global",
    );
    expect(lastCreateEventCollectorConfig?.tenantId).toBe("tn-global");
    // Events were actually pumped into the collector (and message.received filtered).
    expect(collectorEvents.map((e) => e.type)).toEqual([
      "inference.start",
      "inference.done",
    ]);
    // Seam: token usage from the title turn is forwarded to analytics,
    // attributed to the thread instance's principal so it rolls up per member
    // in /insights (CL-2887). The inference.done carries usage; the one-shot's
    // own agent id namespaces the idempotency key.
    expect(analyticsMock.onLocalInferenceEvent).toHaveBeenCalled();
    const call = analyticsMock.onLocalInferenceEvent.mock.calls.find(
      (c) =>
        (c[0] as { event: { type: string } }).event.type === "inference.done",
    );
    expect(call).toBeDefined();
    const arg = call?.[0] as {
      tenantId: string;
      attributionPrincipalId: string;
      eventAddress: string;
    };
    expect(arg.tenantId).toBe("tn-global");
    expect(arg.attributionPrincipalId).toBe("prn-inst");
    expect(arg.eventAddress).toMatch(/^myra-title-/);
  });

  it("aborts a wedged turn on timeout, closing the agent and returning the fallback (CL-2866)", async () => {
    resetTitleMocks();
    // The turn hangs after inference; only close() can settle it.
    agentSendHangs = true;
    titleTurnTimeoutMs = 20;
    const fallback = {
      id: "map-1",
      instanceId: "inst-1",
      label: "How should we price the enterprise tier",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      lastActivityAt: new Date("2026-01-01T00:00:00Z"),
    };
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat" },
      renamed: fallback,
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "How should we price the enterprise tier?",
      // biome-ignore lint/suspicious/noExplicitAny: structural opts
    } as any);

    // The deadline must not hang the caller; it returns the persisted fallback.
    expect(result?.label).toBe("How should we price the enterprise tier");
    // The abort tore the agent down — close() ran, releasing the workdir lock.
    // Pre-CL-2866 the Promise.race abandoned the turn and close() was never hit.
    // The exact count is timing-dependent (onAbort + the orphaned catch both
    // close, idempotently), so we only assert close was invoked at all.
    expect(agentCloseCalls).toBeGreaterThanOrEqual(1);
  });

  it("does not wedge subsequent turns when the first turn hangs in teardown (CL-2866)", async () => {
    resetTitleMocks();
    // The reported wedge: inference completes but close()/audit-commit never
    // settles. Abort cannot unblock an in-flight close, so only the deadline
    // racing the whole turn keeps the per-principal chain from pinning.
    agentCloseHangs = true;
    titleTurnTimeoutMs = 20;
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat" },
      renamed: {
        id: "map-1",
        instanceId: "inst-1",
        label: "First fallback",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastActivityAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const first = await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "First message",
      // biome-ignore lint/suspicious/noExplicitAny: structural opts
    } as any);
    // The wedged first turn still returns (its fallback) and fired the abort's
    // close() attempt rather than hanging the caller.
    expect(first?.label).toBe("First fallback");
    expect(agentCloseCalls).toBeGreaterThanOrEqual(1);

    // A second, healthy turn for the same principal must proceed rather than
    // queue forever behind the wedged first turn's serialization tail.
    agentCloseHangs = false;
    titleTurnTimeoutMs = 45_000;
    const db2 = buildTitleDb({
      mappingRow: { id: "map-2", instanceId: "inst-2", label: "Chat" },
      renamed: {
        id: "map-2",
        instanceId: "inst-2",
        label: "Pricing Deep Dive",
        createdAt: new Date("2026-01-02T00:00:00Z"),
        lastActivityAt: new Date("2026-01-02T00:00:00Z"),
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const second = await generateMyraThreadTitle(db2 as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-2",
      firstMessage: "Second message about pricing",
      // biome-ignore lint/suspicious/noExplicitAny: structural opts
    } as any);

    expect(second?.label).toBe("Pricing Deep Dive");
  });

  it("resolves the title source via the tenant hierarchy for a sub-tenant", async () => {
    resetTitleMocks();
    ancestorChainResult = ["tn-child", "tn-root"];
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat" },
      renamed: {
        id: "map-1",
        instanceId: "inst-1",
        label: "Pricing Deep Dive",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastActivityAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    // The Myra definition lives only in the root ancestor, not the active child.
    db.query.agent.findMany = mock(() =>
      Promise.resolve([
        { id: "agt", tenantId: "tn-root", modelRequirements: null },
      ]),
    );

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-child",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "How should we price the enterprise tier?",
    });

    expect(result?.label).toBe("Pricing Deep Dive");
    // The recorded turn is attributed to the active child tenant.
    expect(lastCreateEventCollectorConfig?.tenantId).toBe("tn-child");
  });

  it("no-ops on a custom (non-default) label without running inference", async () => {
    resetTitleMocks();
    const db = buildTitleDb({
      mappingRow: {
        id: "map-1",
        instanceId: "inst-1",
        label: "Existing Title",
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "Hello",
    });

    expect(result).toBeNull();
    expect(lastCreateEventCollectorConfig).toBeNull();
  });

  it("returns null when the mapping is not found", async () => {
    resetTitleMocks();
    const db = buildTitleDb({ mappingRow: undefined });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "missing",
      firstMessage: "Hello",
    });

    expect(result).toBeNull();
  });

  // db.update spy that captures the label handed to renameMyraThread and echoes
  // it back as the persisted row, so a test can assert the exact fallback title.
  function captureRenameLabel(db: ReturnType<typeof buildTitleDb>): {
    labelRef: { value: string | null };
  } {
    const labelRef: { value: string | null } = { value: null };
    db.update = mock(() => ({
      set: (vals: { label: string }) => {
        labelRef.value = vals.label;
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  id: "map-1",
                  instanceId: "inst-1",
                  label: vals.label,
                  createdAt: new Date("2026-01-01T00:00:00Z"),
                  lastActivityAt: new Date("2026-01-01T00:00:00Z"),
                },
              ]),
          }),
        };
      },
    })) as never;
    return { labelRef };
  }

  it("propagates a genuine credential-resolution fault to the fallback without running inference", async () => {
    resetTitleMocks();
    // A real fault (e.g. ambiguous credential match), not the optional title
    // credential simply being absent.
    resolveCredentialRequirementMock.mockImplementation(() =>
      Promise.reject(new Error("Ambiguous credential match")),
    );
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat" },
    });
    const { labelRef } = captureRenameLabel(db);

    try {
      // biome-ignore lint/suspicious/noExplicitAny: structural db mock
      const result = await generateMyraThreadTitle(db as any, titleDeps, {
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
        threadId: "map-1",
        firstMessage: "Hello",
      });

      // The fault short-circuits BEFORE any inference turn (propagated to the
      // handler, not swallowed and continued to a fallback source that would run
      // a turn), then the first-message fallback names the thread.
      expect(lastCreateEventCollectorConfig).toBeNull();
      expect(labelRef.value).toBe("Hello");
      expect(result?.label).toBe("Hello");
    } finally {
      resolveCredentialRequirementMock.mockImplementation(() =>
        Promise.resolve(null),
      );
    }
  });

  it("falls back to the first-message title (logged at error) when inference throws", async () => {
    resetTitleMocks();
    agentShouldThrow = true;
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat 2" },
    });
    const { labelRef } = captureRenameLabel(db);

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "Hello",
    });

    expect(labelRef.value).toBe("Hello");
    expect(result?.label).toBe("Hello");
  });

  it("falls back to the first-message title when the inference turn yields no usable text", async () => {
    // The real-world CL-2449 failure: chat works but the title turn comes back
    // empty (model/config fault). The turn does not throw — it produces empty
    // text. Rather than leave the default label, name the thread from its first
    // message (truncated on a word boundary, trailing punctuation stripped).
    resetTitleMocks();
    agentReply = "   ";
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat" },
    });
    const { labelRef } = captureRenameLabel(db);

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "How should we price the enterprise tier?",
    });

    // The turn DID run (the failure is empty output, not a skipped turn),
    // recorded under the tenant's bookkeeping instance, not "inst-1" (CL-3894).
    expect(lastCreateEventCollectorConfig?.instanceId).toBe(
      "ins_myra-title-tn-global",
    );
    // 40-char message (<= 48 budget): whole message, trailing "?" stripped.
    expect(labelRef.value).toBe("How should we price the enterprise tier");
    expect(result?.label).toBe("How should we price the enterprise tier");
  });

  it("truncates a long first-message fallback on a word boundary", async () => {
    resetTitleMocks();
    agentShouldThrow = true;
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat" },
    });
    const { labelRef } = captureRenameLabel(db);

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage:
        "Can you help me put together a comprehensive pricing strategy",
    });

    // Budget 48 chars; break at the last word boundary within it.
    expect(labelRef.value).toBe("Can you help me put together a comprehensive");
    expect((labelRef.value ?? "").length).toBeLessThanOrEqual(48);
  });

  it("sanitizes the model output before persisting it", async () => {
    resetTitleMocks();
    agentReply = '  "Pricing  Strategy."  \n';
    let persistedLabel = "";
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "" },
      renamed: {
        id: "map-1",
        instanceId: "inst-1",
        label: "Pricing Strategy",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastActivityAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    // Capture the label handed to update().set().
    db.update = mock(() => ({
      set: (vals: { label: string }) => {
        persistedLabel = vals.label;
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  id: "map-1",
                  instanceId: "inst-1",
                  label: vals.label,
                  createdAt: new Date("2026-01-01T00:00:00Z"),
                  lastActivityAt: new Date("2026-01-01T00:00:00Z"),
                },
              ]),
          }),
        };
      },
    })) as never;

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "pricing?",
    });

    expect(persistedLabel).toBe("Pricing Strategy");
    expect(result?.label).toBe("Pricing Strategy");
    // The scratch repo lives on the hub dataDir volume (like the file parser
    // and every other agent repo), grouped per (tenant, principal) with a fresh
    // per-generation id so no repo is reused or grown, and no GC policy (CL-2887).
    expect(lastIsogitDir).toMatch(
      /^\/tmp\/myra-title-test\/myra-title\/tn-global\/prn-member\/[0-9a-f-]{36}$/,
    );
    expect(lastIsogitGcPolicy).toBeNull();
  });

  it("uses a fresh per-generation repo so no repo is reused or grown (CL-2887)", async () => {
    resetTitleMocks();
    const makeDb = (mapId: string, instanceId: string) =>
      buildTitleDb({
        mappingRow: { id: mapId, instanceId, label: "Chat" },
        renamed: {
          id: mapId,
          instanceId,
          label: "Titled",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          lastActivityAt: new Date("2026-01-01T00:00:00Z"),
        },
      });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    await generateMyraThreadTitle(makeDb("map-1", "inst-1") as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "first thread",
      // biome-ignore lint/suspicious/noExplicitAny: structural opts
    } as any);
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    await generateMyraThreadTitle(makeDb("map-2", "inst-2") as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-2",
      firstMessage: "second thread",
      // biome-ignore lint/suspicious/noExplicitAny: structural opts
    } as any);

    const titleRepos = isogitDirs.filter((d) => d.includes("/myra-title/"));
    expect(titleRepos).toHaveLength(2);
    // Two generations for the SAME principal must land in distinct per-generation
    // repos — the pre-CL-2887 shared per-principal repo reused one path and grew
    // unbounded (and it repacked the whole history on each commit, hanging send).
    expect(titleRepos[0]).not.toBe(titleRepos[1]);
    for (const dir of titleRepos) {
      expect(dir).toMatch(
        /\/myra-title\/tn-global\/prn-member\/[0-9a-f-]{36}$/,
      );
    }
  });

  it("returns null when firstMessage is blank without touching the db", async () => {
    resetTitleMocks();
    const findFirst = mock(() => Promise.resolve(undefined));
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = { query: { memberAgentInstance: { findFirst } } };

    const result = await generateMyraThreadTitle(db, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "   ",
    });

    expect(result).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("skips the LLM turn for a very short, content-free first message and keeps the fallback (CL-3870)", async () => {
    resetTitleMocks();
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat" },
    });
    const { labelRef } = captureRenameLabel(db);

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "hi",
    });

    // No inference turn ran — a message this short is degenerate input for a
    // title model and is exactly the case observed to hallucinate an
    // unrelated title.
    expect(lastCreateEventCollectorConfig).toBeNull();
    expect(labelRef.value).toBe("hi");
    expect(result?.label).toBe("hi");
  });

  it("falls back to the first-message title when the title turn's own inference cycle fails, never persisting the SDK's synthesized error text (CL-3870)", async () => {
    resetTitleMocks();
    agentInferenceErrors = true;
    // If this ever leaked through as the title, the assertions below would
    // catch it.
    agentReply =
      "This agent could not complete your request due to a credential error [HTTP 402]: insufficient balance";
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat" },
    });
    const { labelRef } = captureRenameLabel(db);

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(db as any, titleDeps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      firstMessage: "How should we price the enterprise tier?",
    });

    expect(labelRef.value).toBe("How should we price the enterprise tier");
    expect(result?.label).toBe("How should we price the enterprise tier");
    expect(labelRef.value).not.toContain("credential error");
  });
});

describe("listMyraThreads", () => {
  it("maps rows (including lastActivityAt and firstMessageAt) and falls back to default labels by position", async () => {
    const rows = [
      {
        id: "map-1",
        instanceId: "inst-1",
        label: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastActivityAt: new Date("2026-01-05T00:00:00Z"),
        firstMessageAt: new Date("2026-01-04T00:00:00Z"),
      },
      {
        id: "map-2",
        instanceId: "inst-2",
        label: "  ",
        createdAt: new Date("2026-01-02T00:00:00Z"),
        lastActivityAt: new Date("2026-01-02T00:00:00Z"),
        firstMessageAt: null,
      },
      {
        id: "map-3",
        instanceId: "inst-3",
        label: "Pricing deep dive",
        createdAt: new Date("2026-01-03T00:00:00Z"),
        lastActivityAt: new Date("2026-01-03T00:00:00Z"),
        firstMessageAt: null,
      },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = {
      query: {
        memberAgentInstance: { findMany: mock(() => Promise.resolve(rows)) },
      },
    };

    const page = await listMyraThreads(db, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
    });

    expect(page.threads).toEqual([
      {
        id: "map-1",
        instanceId: "inst-1",
        label: "Chat",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-05T00:00:00.000Z",
        firstMessageAt: "2026-01-04T00:00:00.000Z",
      },
      {
        id: "map-2",
        instanceId: "inst-2",
        label: "Chat 2",
        createdAt: "2026-01-02T00:00:00.000Z",
        lastActivityAt: "2026-01-02T00:00:00.000Z",
        firstMessageAt: null,
      },
      {
        id: "map-3",
        instanceId: "inst-3",
        label: "Pricing deep dive",
        createdAt: "2026-01-03T00:00:00.000Z",
        lastActivityAt: "2026-01-03T00:00:00.000Z",
        firstMessageAt: null,
      },
    ]);
    // Unlimited fetch returned every row, so total is the row count with no
    // separate count query.
    expect(page.total).toBe(3);
  });

  it("orders by lastActivityAt desc and forwards the limit, counting the full set", async () => {
    let findManyArg: { orderBy?: unknown; limit?: number } | undefined;
    const findMany = mock((arg: { orderBy?: unknown; limit?: number }) => {
      findManyArg = arg;
      return Promise.resolve([]);
    });
    const $count = mock(() => Promise.resolve(42));
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = { query: { memberAgentInstance: { findMany } }, $count };

    const page = await listMyraThreads(db, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      limit: 10,
    });

    expect(findManyArg?.limit).toBe(10);
    // A limited page reports the member's full count (for "view all"), not the
    // page size.
    expect(page.total).toBe(42);
    expect($count).toHaveBeenCalledTimes(1);
    // Sort is lastActivityAt, then createdAt, then id — all descending — so
    // most-recently-active is first and ties are deterministic.
    expect(findManyArg?.orderBy).toEqual([
      desc(memberAgentInstance.lastActivityAt),
      desc(memberAgentInstance.createdAt),
      desc(memberAgentInstance.id),
    ]);
  });

  it("omits limit and skips the count query for the full list", async () => {
    let findManyArg: { limit?: number } | undefined;
    const findMany = mock((arg: { limit?: number }) => {
      findManyArg = arg;
      return Promise.resolve([]);
    });
    const $count = mock(() => Promise.resolve(99));
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = { query: { memberAgentInstance: { findMany } }, $count };

    const page = await listMyraThreads(db, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
    });

    expect(findManyArg && "limit" in findManyArg).toBe(false);
    // No separate count for the full list; total derives from the rows.
    expect($count).not.toHaveBeenCalled();
    expect(page.total).toBe(0);
  });
});

describe("recordMyraThreadActivity", () => {
  it("bumps last_activity_at for exactly the given instance's row", async () => {
    let updatedTable: unknown;
    let setValues: Record<string, unknown> | undefined;
    let whereArg: unknown;
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = {
      update: mock((table: unknown) => {
        updatedTable = table;
        return {
          set: (vals: Record<string, unknown>) => {
            setValues = vals;
            return {
              where: (arg: unknown) => {
                whereArg = arg;
                return Promise.resolve(undefined);
              },
            };
          },
        };
      }),
    };

    await recordMyraThreadActivity(db, "inst-1");

    // Updates the member_agent_instance row keyed by instanceId, setting a fresh
    // timestamp — i.e. the WHERE targets this instance, not a blanket update.
    expect(updatedTable).toBe(memberAgentInstance);
    expect(setValues?.lastActivityAt).toBeInstanceOf(Date);
    // CL-3749: the same bump stamps first_message_at (only when still unset —
    // the value is a COALESCE SQL expression, not a plain Date) so thread
    // lists can distinguish used threads from never-used ones.
    expect(setValues?.firstMessageAt).toBeDefined();
    expect(whereArg).toEqual(eq(memberAgentInstance.instanceId, "inst-1"));
  });
});

describe("renameMyraThread", () => {
  it("returns the mapped row when a row is updated", async () => {
    const returning = mock(() =>
      Promise.resolve([
        {
          id: "map-1",
          instanceId: "inst-1",
          label: "New label",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          lastActivityAt: new Date("2026-01-06T00:00:00Z"),
          firstMessageAt: new Date("2026-01-05T00:00:00Z"),
        },
      ]),
    );
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = {
      update: mock(() => ({ set: () => ({ where: () => ({ returning }) }) })),
    };

    const result = await renameMyraThread(db, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      label: "  New label  ",
    });

    expect(result).toEqual({
      id: "map-1",
      instanceId: "inst-1",
      label: "New label",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-06T00:00:00.000Z",
      firstMessageAt: "2026-01-05T00:00:00.000Z",
    });
    expect(returning).toHaveBeenCalled();
  });

  it("returns null when no row matched", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = {
      update: mock(() => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([]) }),
        }),
      })),
    };

    const result = await renameMyraThread(db, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-x",
      label: "New label",
    });

    expect(result).toBeNull();
  });

  it("returns null without touching the db when the label is empty", async () => {
    const update = mock(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    }));
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = { update };

    const result = await renameMyraThread(db, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      label: "   ",
    });

    expect(result).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("deleteMyraThread", () => {
  function buildDeleteDb(
    mappingRow: unknown,
    instanceRow: unknown,
    deleteSpy: () => void,
  ) {
    return {
      query: {
        memberAgentInstance: {
          findFirst: mock(() => Promise.resolve(mappingRow)),
        },
        agentInstance: { findFirst: mock(() => Promise.resolve(instanceRow)) },
      },
      transaction: mock(async (fn: (tx: unknown) => Promise<void>) => {
        await fn({
          delete: () => {
            deleteSpy();
            return { where: () => Promise.resolve(undefined) };
          },
        });
      }),
    };
  }

  it("ends the session, deletes the rows, and returns true", async () => {
    let deletes = 0;
    const db = buildDeleteDb(
      { id: "map-1", instanceId: "inst-1" },
      { id: "inst-1", address: "inst-1@myra.test", principalId: "prn-inst-1" },
      () => {
        deletes += 1;
      },
    );
    const endSession = mock(() => Promise.resolve());
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const deps: any = { sessionService: { endSession } };

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await deleteMyraThread(db as any, deps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
    });

    expect(result).toBe(true);
    expect(endSession).toHaveBeenCalledWith(
      "inst-1@myra.test",
      "myra_thread_deleted",
    );
    // grant, member mapping, instance, agent_session, principal.
    expect(deletes).toBe(5);
  });

  it("returns false and skips teardown when the mapping is not found", async () => {
    const db = buildDeleteDb(undefined, undefined, () => {});
    const endSession = mock(() => Promise.resolve());
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const deps: any = { sessionService: { endSession } };

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await deleteMyraThread(db as any, deps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-x",
    });

    expect(result).toBe(false);
    expect(endSession).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("throws (no silent no-op teardown) when the instance has no principalId", async () => {
    const db = buildDeleteDb(
      { id: "map-1", instanceId: "inst-1" },
      { id: "inst-1", address: "inst-1@myra.test" },
      () => {},
    );
    const endSession = mock(() => Promise.resolve());
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const deps: any = { sessionService: { endSession } };

    let thrown: unknown;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: structural db mock
      await deleteMyraThread(db as any, deps, {
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
        threadId: "map-1",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("no principalId");
    // It must fail before tearing anything down — a partial delete with an
    // empty principalId is exactly the orphan this guards against.
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
