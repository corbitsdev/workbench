import { describe, expect, it } from "bun:test";
import { mock } from "bun:test";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import * as intxDb from "@intx/db";
import type { SessionService } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import { isUuid } from "../lib/uuid";

// getAncestorChain walks the tenant table via the db; the run-starter imports it
// as a singleton from @intx/db. Steer the chain per test while preserving every
// other real export (../db/schema imports `schema` from the same module).
let chainRef: string[] = [];
mock.module("@intx/db", () => ({
  ...intxDb,
  getAncestorChain: async () => chainRef,
}));

const { createWorkflowRunStarter } = await import("./workflow-run-starter");

type Candidate = {
  deploymentId: string | null;
  kind: string;
  tenantId: string;
  principalId: string;
  createdAt: Date;
  deletedAt: Date | null;
};

type TestDb = HubDb & {
  inserted: Record<string, unknown>[];
  failUpdateCalls: number;
};

function makeDb(candidates: Candidate[]): TestDb {
  const inserted: Record<string, unknown>[] = [];
  let failUpdateCalls = 0;
  return {
    query: {
      workflowRun: {
        findMany: async () => candidates,
      },
      // Read by the heartbeat trigger-payload enricher (resolveEnabledBriefSources)
      // for the dedicated "generic-workflow has no enricher, heartbeat does" test
      // below — no stored prefs, so it falls back to each brief source's default.
      memberPreferences: {
        findFirst: async () => undefined,
      },
    },
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        inserted.push(row);
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            failUpdateCalls += 1;
            return [{ id: "flipped" }];
          },
        }),
      }),
    }),
    inserted,
    get failUpdateCalls() {
      return failUpdateCalls;
    },
  } as unknown as TestDb;
}

const DOMAIN = "workbench.example";

const resolveUserIdentity = async (principalId: string) => ({
  userAddress: `usr_${principalId}@${DOMAIN}`,
  userRefId: principalId,
});

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    deploymentId: "dep-1",
    kind: "generic-workflow",
    tenantId: "t-root",
    principalId: "principal-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

describe("createWorkflowRunStarter", () => {
  it("selects the most-specific deployment along the chain and delivers to it", async () => {
    chainRef = ["t-child", "t-root"];
    const sent: Record<string, unknown>[] = [];
    const sessionService = {
      sendUserMessage: async (a: Record<string, unknown>) => {
        sent.push(a);
      },
    } as unknown as SessionService;

    const db = makeDb([
      candidate({ deploymentId: "dep-root", tenantId: "t-root" }),
      candidate({
        deploymentId: "dep-child",
        tenantId: "t-child",
        principalId: "principal-child",
      }),
    ]);
    const starter = createWorkflowRunStarter({
      db,
      sessionService,
      ensureDeploymentRoutable: async () => ({ reestablished: false }),
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity,
    });

    const input = { reason: "scheduled-heartbeat" };
    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-child",
      input,
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ ok: true, deploymentId: "dep-child" });
    if (!result.ok) throw new Error("expected ok result");
    expect(isUuid(result.runId)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.agentAddress).toBe(
      deriveDeploymentAddress({
        deploymentId: "dep-child",
        deploymentDomain: DOMAIN,
      }),
    );
    expect(sent[0]?.content).toBe(
      JSON.stringify({ ...input, runId: result.runId }),
    );
    expect(sent[0]?.tenantId).toBe("t-child");
    expect(sent[0]?.from).toBe(`hub@${DOMAIN}`);
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]?.deploymentId).toBe("dep-child");
    expect(sent[0]?.messageId).toBe(db.inserted[0]?.id);
  });

  it("returns not_found when no candidate is deployed for the kind", async () => {
    chainRef = ["t-root"];
    const starter = createWorkflowRunStarter({
      db: makeDb([]),
      sessionService: {
        sendUserMessage: async () => {
          throw new Error("must not deliver");
        },
      } as unknown as SessionService,
      ensureDeploymentRoutable: async () => ({ reestablished: false }),
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity,
    });

    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  it("ensures routability with the deployment's creator before delivering", async () => {
    chainRef = ["t-root"];
    const sequence: string[] = [];
    let routableArgs: Record<string, unknown> | undefined;
    const sessionService = {
      sendUserMessage: async () => {
        sequence.push("send");
      },
    } as unknown as SessionService;

    const starter = createWorkflowRunStarter({
      db: makeDb([
        candidate({ deploymentId: "dep-1", principalId: "creator-9" }),
      ]),
      sessionService,
      ensureDeploymentRoutable: async (a) => {
        sequence.push("routable");
        routableArgs = a;
        return { reestablished: false };
      },
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity,
    });

    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });

    expect(result.ok).toBe(true);
    expect(sequence).toEqual(["routable", "send"]);
    expect(routableArgs).toEqual({
      deploymentId: "dep-1",
      kind: "generic-workflow",
      tenantId: "t-root",
      creatorPrincipalId: "creator-9",
    });
  });

  it("attributes routability to an explicit creatorPrincipalId when provided", async () => {
    chainRef = ["t-root"];
    let routableArgs: Record<string, unknown> | undefined;
    const starter = createWorkflowRunStarter({
      db: makeDb([
        candidate({ deploymentId: "dep-1", principalId: "deployment-owner" }),
      ]),
      sessionService: {
        sendUserMessage: async () => {},
      } as unknown as SessionService,
      ensureDeploymentRoutable: async (a) => {
        routableArgs = a;
        return { reestablished: false };
      },
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity,
    });

    await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
      creatorPrincipalId: "schedule-owner",
    });

    expect(routableArgs?.creatorPrincipalId).toBe("schedule-owner");
  });

  it("returns delivery_failed when delivery throws", async () => {
    chainRef = ["t-root"];
    const db = makeDb([candidate({ deploymentId: "dep-1" })]);
    const starter = createWorkflowRunStarter({
      db,
      sessionService: {
        sendUserMessage: async () => {
          throw new Error("sidecar unreachable");
        },
      } as unknown as SessionService,
      ensureDeploymentRoutable: async () => ({ reestablished: false }),
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity,
    });

    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("delivery_failed");
    expect(db.inserted).toHaveLength(1);
    expect(db.failUpdateCalls).toBe(1);
  });

  it("starts runs while under the per-tenant hourly budget", async () => {
    chainRef = ["t-root"];
    const starter = createWorkflowRunStarter({
      db: makeDb([candidate({ deploymentId: "dep-1" })]),
      sessionService: {
        sendUserMessage: async () => {},
      } as unknown as SessionService,
      ensureDeploymentRoutable: async () => ({ reestablished: false }),
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity,
      now: () => 1_000,
    });

    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });

    expect(result.ok).toBe(true);
  });

  it("returns rate_limited once the per-tenant hourly budget is exhausted", async () => {
    chainRef = ["t-root"];
    let sends = 0;
    const starter = createWorkflowRunStarter({
      db: makeDb([candidate({ deploymentId: "dep-1" })]),
      sessionService: {
        sendUserMessage: async () => {
          sends += 1;
        },
      } as unknown as SessionService,
      ensureDeploymentRoutable: async () => ({ reestablished: false }),
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity,
      now: () => 1_000,
    });

    for (let i = 0; i < 60; i++) {
      const ok = await starter.startRun({
        kind: "generic-workflow",
        tenantId: "t-root",
        input: {},
      });
      expect(ok.ok).toBe(true);
    }
    expect(sends).toBe(60);

    const blocked = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("rate_limited");
    expect(sends).toBe(60);
  });

  it("exempts scheduler-sourced starts from the budget so a large member fan-out is never dropped", async () => {
    chainRef = ["t-root"];
    let sends = 0;
    const starter = createWorkflowRunStarter({
      db: makeDb([candidate({ deploymentId: "dep-1" })]),
      sessionService: {
        sendUserMessage: async () => {
          sends += 1;
        },
      } as unknown as SessionService,
      ensureDeploymentRoutable: async () => ({ reestablished: false }),
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity,
      now: () => 1_000,
    });

    for (let i = 0; i < 61; i++) {
      const ok = await starter.startRun({
        kind: "generic-workflow",
        tenantId: "t-root",
        input: {},
        source: "scheduler",
      });
      expect(ok.ok).toBe(true);
    }
    expect(sends).toBe(61);

    const nonScheduler = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });
    expect(nonScheduler.ok).toBe(true);
  });

  it("slides the window: the budget frees up once old starts expire", async () => {
    chainRef = ["t-root"];
    let clock = 1_000;
    const starter = createWorkflowRunStarter({
      db: makeDb([candidate({ deploymentId: "dep-1" })]),
      sessionService: {
        sendUserMessage: async () => {},
      } as unknown as SessionService,
      ensureDeploymentRoutable: async () => ({ reestablished: false }),
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity,
      now: () => clock,
    });

    for (let i = 0; i < 60; i++) {
      await starter.startRun({
        kind: "generic-workflow",
        tenantId: "t-root",
        input: {},
      });
    }
    const blocked = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });
    expect(blocked.ok).toBe(false);

    clock += 60 * 60 * 1000 + 1;
    const afterWindow = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });
    expect(afterWindow.ok).toBe(true);
  });

  it("isolates the start budget per tenant", async () => {
    chainRef = ["t-a"];
    const db = makeDb([
      candidate({ deploymentId: "dep-a", tenantId: "t-a" }),
      candidate({ deploymentId: "dep-b", tenantId: "t-b" }),
    ]);
    const starter = createWorkflowRunStarter({
      db,
      sessionService: {
        sendUserMessage: async () => {},
      } as unknown as SessionService,
      ensureDeploymentRoutable: async () => ({ reestablished: false }),
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity,
      now: () => 1_000,
    });

    for (let i = 0; i < 60; i++) {
      await starter.startRun({
        kind: "generic-workflow",
        tenantId: "t-a",
        input: {},
      });
    }
    const blockedA = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-a",
      input: {},
    });
    expect(blockedA.ok).toBe(false);

    chainRef = ["t-b"];
    const okB = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-b",
      input: {},
    });
    expect(okB.ok).toBe(true);
  });

  // This starter is the THIRD workflow-start door (webhook triggers via
  // ../routes/webhook-trigger-fire.ts, and the heartbeat manual-run route's own
  // richer call which already enriches before calling in) — it must apply the
  // same kind-registered trigger-payload enrichment as the other two doors
  // (run-exec.ts's startWorkflowRun), not skip it because it delivers via a
  // different code path.
  it("a webhook-fired heartbeat run gets enabledSources, identity, and createdAfter — not just whatever the webhook payload carried", async () => {
    chainRef = ["t-root"];
    const sent: Record<string, unknown>[] = [];
    const sessionService = {
      sendUserMessage: async (a: Record<string, unknown>) => {
        sent.push(a);
      },
    } as unknown as SessionService;

    const starter = createWorkflowRunStarter({
      db: makeDb([candidate({ deploymentId: "dep-1", kind: "heartbeat" })]),
      sessionService,
      ensureDeploymentRoutable: async () => ({ reestablished: false }),
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity: async (principalId: string) => ({
        userAddress: `usr_${principalId}@${DOMAIN}`,
        userRefId: principalId,
        userDisplayName: "Jordan Lee",
      }),
    });

    // The exact shape webhook-trigger-fire.ts's dispatchRun sends: no
    // enrichment of its own, just the raw webhook payload wrapped once.
    const result = await starter.startRun({
      kind: "heartbeat",
      tenantId: "t-root",
      input: { reason: "webhook", triggerId: "wht_1", payload: {} },
      source: "webhook",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(sent).toHaveLength(1);
    const delivered = JSON.parse(sent[0]?.content as string) as Record<
      string,
      unknown
    >;
    expect(delivered.enabledSources).toEqual([]);
    expect(delivered.userDisplayName).toBe("Jordan Lee");
    expect(typeof delivered.userAddress).toBe("string");
    expect(typeof delivered.createdAfter).toBe("string");
    // The webhook's own fields survive the enrichment merge.
    expect(delivered.triggerId).toBe("wht_1");
  });

  it("a webhook-fired run of an un-registered kind is delivered unchanged", async () => {
    chainRef = ["t-root"];
    const sent: Record<string, unknown>[] = [];
    const sessionService = {
      sendUserMessage: async (a: Record<string, unknown>) => {
        sent.push(a);
      },
    } as unknown as SessionService;

    const starter = createWorkflowRunStarter({
      db: makeDb([
        candidate({ deploymentId: "dep-1", kind: "generic-workflow" }),
      ]),
      sessionService,
      ensureDeploymentRoutable: async () => ({ reestablished: false }),
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity,
    });

    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: { reason: "webhook", triggerId: "wht_2", payload: { a: 1 } },
      source: "webhook",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const delivered = JSON.parse(sent[0]?.content as string) as Record<
      string,
      unknown
    >;
    expect("enabledSources" in delivered).toBe(false);
    expect(delivered).toEqual({
      reason: "webhook",
      triggerId: "wht_2",
      payload: { a: 1 },
      runId: result.runId,
    });
  });

  // Same fail-loud invariant as the other two start doors: resolveUserIdentity
  // throwing on a missing principal must fail the whole start, not degrade to
  // an unenriched delivery.
  it("a webhook-fired heartbeat run whose identity cannot be resolved fails the start instead of delivering unenriched", async () => {
    chainRef = ["t-root"];
    const sent: Record<string, unknown>[] = [];
    const sessionService = {
      sendUserMessage: async (a: Record<string, unknown>) => {
        sent.push(a);
      },
    } as unknown as SessionService;

    const starter = createWorkflowRunStarter({
      db: makeDb([candidate({ deploymentId: "dep-1", kind: "heartbeat" })]),
      sessionService,
      ensureDeploymentRoutable: async () => ({ reestablished: false }),
      deploymentDomain: DOMAIN,
      cryptoProvider: {} as never,
      resolveUserIdentity: async () => {
        throw new Error("principal not found: prn-ghost");
      },
    });

    await expect(
      starter.startRun({
        kind: "heartbeat",
        tenantId: "t-root",
        input: { reason: "webhook", triggerId: "wht_3", payload: {} },
        source: "webhook",
      }),
    ).rejects.toThrow("principal not found: prn-ghost");
    expect(sent).toHaveLength(0);
  });
});
