import { describe, expect, it } from "bun:test";
import { mock } from "bun:test";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import * as intxDb from "@intx/db";
import type { SessionService } from "@intx/hub-sessions";
import type { HubDb } from "../db";

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

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    deploymentId: "dep-1",
    kind: "heartbeat",
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
    });

    const input = { reason: "scheduled-heartbeat" };
    const result = await starter.startRun({
      kind: "heartbeat",
      tenantId: "t-child",
      input,
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ ok: true, deploymentId: "dep-child" });
    if (!result.ok) throw new Error("expected ok result");
    expect(typeof result.runId).toBe("string");
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
    });

    const result = await starter.startRun({
      kind: "heartbeat",
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
    });

    const result = await starter.startRun({
      kind: "heartbeat",
      tenantId: "t-root",
      input: {},
    });

    expect(result.ok).toBe(true);
    expect(sequence).toEqual(["routable", "send"]);
    expect(routableArgs).toEqual({
      deploymentId: "dep-1",
      kind: "heartbeat",
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
    });

    await starter.startRun({
      kind: "heartbeat",
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
    });

    const result = await starter.startRun({
      kind: "heartbeat",
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
      now: () => 1_000,
    });

    const result = await starter.startRun({
      kind: "heartbeat",
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
      now: () => 1_000,
    });

    for (let i = 0; i < 60; i++) {
      const ok = await starter.startRun({
        kind: "heartbeat",
        tenantId: "t-root",
        input: {},
      });
      expect(ok.ok).toBe(true);
    }
    expect(sends).toBe(60);

    const blocked = await starter.startRun({
      kind: "heartbeat",
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
      now: () => 1_000,
    });

    for (let i = 0; i < 61; i++) {
      const ok = await starter.startRun({
        kind: "heartbeat",
        tenantId: "t-root",
        input: {},
        source: "scheduler",
      });
      expect(ok.ok).toBe(true);
    }
    expect(sends).toBe(61);

    const nonScheduler = await starter.startRun({
      kind: "heartbeat",
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
      now: () => clock,
    });

    for (let i = 0; i < 60; i++) {
      await starter.startRun({
        kind: "heartbeat",
        tenantId: "t-root",
        input: {},
      });
    }
    const blocked = await starter.startRun({
      kind: "heartbeat",
      tenantId: "t-root",
      input: {},
    });
    expect(blocked.ok).toBe(false);

    clock += 60 * 60 * 1000 + 1;
    const afterWindow = await starter.startRun({
      kind: "heartbeat",
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
      now: () => 1_000,
    });

    for (let i = 0; i < 60; i++) {
      await starter.startRun({ kind: "heartbeat", tenantId: "t-a", input: {} });
    }
    const blockedA = await starter.startRun({
      kind: "heartbeat",
      tenantId: "t-a",
      input: {},
    });
    expect(blockedA.ok).toBe(false);

    chainRef = ["t-b"];
    const okB = await starter.startRun({
      kind: "heartbeat",
      tenantId: "t-b",
      input: {},
    });
    expect(okB.ok).toBe(true);
  });
});
