import { describe, expect, mock, test } from "bun:test";
import type { CryptoProvider } from "@intx/types/runtime";
import type { SessionService } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import { isUuid } from "../lib/uuid";
import type { RunState } from "./run-store";

// CL-2755: the async-start contract of `startWorkflowRun`. The run row is seeded
// `provisioning` and returned BEFORE the per-run deployment cold-start; the
// provision + trigger run on a detached `backgroundTask` the caller can await for
// deterministic assertions. An in-memory run-store makes the row observable
// without a DB; the provision + session deps are injected fakes.

const rows = new Map<string, RunState>();
const insertedInputs = new Map<string, unknown>();
mock.module("./run-store", () => ({
  insertRunRecord: async (
    _db: unknown,
    args: {
      runId: string;
      deploymentId: string | null;
      kind: string;
      tenantId: string;
      principalId: string;
      input: unknown;
      originConversationId: string | null;
      status?: RunState["status"];
    },
  ) => {
    const state: RunState = {
      runId: args.runId,
      kind: args.kind,
      tenantId: args.tenantId,
      principalId: args.principalId,
      status: args.status ?? "running",
      ...(args.deploymentId !== null
        ? { deploymentId: args.deploymentId }
        : {}),
    };
    rows.set(state.runId, structuredClone(state));
    insertedInputs.set(state.runId, structuredClone(args.input));
    return state;
  },
  setRunStatus: async (
    _db: unknown,
    runId: string,
    status: RunState["status"],
  ) => {
    const found = rows.get(runId);
    if (found) rows.set(runId, structuredClone({ ...found, status }));
  },
  // CAS: fail only if still provisioning (mirrors the real predicate).
  failRunIfStillProvisioning: async (_db: unknown, runId: string) => {
    const found = rows.get(runId);
    if (found && found.status === "provisioning") {
      rows.set(runId, structuredClone({ ...found, status: "failed" }));
      return true;
    }
    return false;
  },
  setRunDeployment: async (
    _db: unknown,
    runId: string,
    deploymentId: string,
  ) => {
    const found = rows.get(runId);
    if (found) rows.set(runId, structuredClone({ ...found, deploymentId }));
  },
  loadRunRecord: async (_db: unknown, runId: string) => {
    const found = rows.get(runId);
    return found ? structuredClone(found) : null;
  },
  setPendingSignal: async () => {},
}));

const { startWorkflowRun } = await import("./run-exec");

const DEFINITION = {
  kind: "pain-point-collateral",
  tenantId: "tn-1",
  deploymentId: "ses_dep1",
  principalId: "prn-deployer",
  createdAt: new Date(),
};

function makeDb(): HubDb {
  // biome-ignore lint/suspicious/noExplicitAny: structural test mock
  const db: any = {
    query: {
      workflowRun: { findMany: async () => [DEFINITION] },
      role: { findMany: async () => [] },
    },
  };
  return db as HubDb;
}

const sent: { agentAddress: string; messageId: string; content: string }[] = [];
const sessionService = {
  sendUserMessage: async (args: {
    agentAddress: string;
    messageId: string;
    content: string;
  }) => {
    sent.push({
      agentAddress: args.agentAddress,
      messageId: args.messageId,
      content: args.content,
    });
  },
} as unknown as SessionService;

const reclaimCalls: {
  deploymentId: string;
  tenantId: string;
  reason: string;
}[] = [];

function baseDeps(provision: typeof provisionOk) {
  return {
    db: makeDb(),
    sessionService,
    cryptoProvider: {} as CryptoProvider,
    deploymentDomain: "wf.localhost",
    provisionRunDeployment: provision,
    reclaimDeployment: async (args: {
      deploymentId: string;
      tenantId: string;
      reason: string;
    }) => {
      reclaimCalls.push(args);
    },
    resolveUserIdentity: async (principalId: string) => ({
      userAddress: `usr_${principalId}@wf.localhost`,
      userRefId: principalId,
    }),
  };
}

const provisionOk = async () => ({ deploymentId: "ses_run_1" });

function reset(): void {
  rows.clear();
  insertedInputs.clear();
  sent.length = 0;
  reclaimCalls.length = 0;
}

const startOpts = {
  kind: "pain-point-collateral",
  chain: ["tn-1"] as const,
  principalId: "prn-1",
  input: { topic: "Acme" },
  originConversationId: null,
};

describe("startWorkflowRun async-start contract (CL-2755)", () => {
  test("returns 'provisioning' BEFORE the (still-pending) provision resolves, with the row already durable and no trigger yet", async () => {
    reset();
    let resolveProvision: (v: { deploymentId: string }) => void = () => {};
    const pending = new Promise<{ deploymentId: string }>((res) => {
      resolveProvision = res;
    });
    let provisionCalled = false;
    const provision = async () => {
      provisionCalled = true;
      return pending;
    };

    const result = await startWorkflowRun(baseDeps(provision), startOpts);

    // The response resolved while the deploy is still in flight.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state.status).toBe("provisioning");
    expect(result.state.deploymentId).toBeUndefined();
    // The row exists and is durable the instant we return.
    expect(rows.get(result.state.runId)?.status).toBe("provisioning");
    // Provision was kicked off but has NOT resolved; the trigger has not fired.
    expect(provisionCalled).toBe(true);
    expect(sent).toHaveLength(0);

    // Let the tail finish and confirm it then proceeds.
    resolveProvision({ deploymentId: "ses_run_1" });
    await result.backgroundTask;
    expect(sent).toHaveLength(1);
  });

  test("on success the background tail fires the trigger AFTER provisioning, addressed to the provisioned deployment", async () => {
    reset();
    const order: string[] = [];
    const provision = async () => {
      order.push("provision");
      return { deploymentId: "ses_run_1" };
    };
    const service = {
      sendUserMessage: async (args: { agentAddress: string }) => {
        order.push("trigger");
        sent.push({
          agentAddress: args.agentAddress,
          messageId: "",
          content: "",
        });
      },
    } as unknown as SessionService;

    const result = await startWorkflowRun(
      { ...baseDeps(provision), sessionService: service },
      startOpts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    await result.backgroundTask;

    expect(order).toEqual(["provision", "trigger"]);
    // Addressed to the freshly-provisioned per-run deployment.
    expect(sent[0]?.agentAddress).toBe("ins_ses_run_1@wf.localhost");
    // The deployment was attached to the run before the trigger.
    expect(rows.get(result.state.runId)?.deploymentId).toBe("ses_run_1");
  });

  test("CL-3521: durable input and trigger mail include hub-minted runId (workflow-run-starter parity)", async () => {
    reset();
    const result = await startWorkflowRun(baseDeps(provisionOk), startOpts);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    await result.backgroundTask;

    const runId = result.state.runId;
    expect(isUuid(runId)).toBe(true);
    expect(insertedInputs.get(runId)).toEqual({ topic: "Acme", runId });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messageId).toBe(runId);
    expect(JSON.parse(sent[0]?.content ?? "{}")).toEqual({
      topic: "Acme",
      runId,
    });
  });

  test("a provision failure flips the run to failed and fires NO trigger", async () => {
    reset();
    const provision = async () => {
      throw new Error("deploy failed");
    };

    const result = await startWorkflowRun(baseDeps(provision), startOpts);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // The response still acked provisioning — the failure is asynchronous.
    expect(result.state.status).toBe("provisioning");

    await result.backgroundTask;

    // Loud, terminal failure surfaced on the record; never stuck provisioning.
    expect(rows.get(result.state.runId)?.status).toBe("failed");
    expect(sent).toHaveLength(0);
  });

  test("a provision that resolves AFTER the run was already failed (deadline race) does NOT attach a deployment, does NOT fire the trigger, and reclaims the orphaned deployment (CL-2755 MAJOR-1)", async () => {
    reset();
    let resolveProvision: (v: { deploymentId: string }) => void = () => {};
    const pending = new Promise<{ deploymentId: string }>((res) => {
      resolveProvision = res;
    });
    const provision = async () => pending;

    const deps = baseDeps(provision);
    const result = await startWorkflowRun(deps, startOpts);
    if (!result.ok) throw new Error("unreachable");
    const runId = result.state.runId;

    // Simulate the hard deadline / a concurrent fail winning the race while the
    // provision is still in flight: the run is already `failed`.
    rows.set(runId, structuredClone({ ...rows.get(runId)!, status: "failed" }));

    // NOW the slow provision finally resolves — the abandoned tail must bail.
    resolveProvision({ deploymentId: "ses_run_1" });
    await result.backgroundTask;

    // No deployment attached behind the failed record, and no trigger fired.
    expect(rows.get(runId)?.deploymentId).toBeUndefined();
    expect(rows.get(runId)?.status).toBe("failed");
    expect(sent).toHaveLength(0);
    // The minted-but-abandoned deployment is reclaimed so it never runs behind
    // the failed record (a phantom run).
    expect(reclaimCalls).toHaveLength(1);
    expect(reclaimCalls[0]?.deploymentId).toBe("ses_run_1");
    expect(reclaimCalls[0]?.tenantId).toBe("tn-1");
  });

  test("returns 404 without seeding a row when no workflow of the kind is deployed", async () => {
    reset();
    // biome-ignore lint/suspicious/noExplicitAny: structural test mock
    const db: any = {
      query: {
        workflowRun: { findMany: async () => [] },
        role: { findMany: async () => [] },
      },
    };
    const result = await startWorkflowRun(
      { ...baseDeps(provisionOk), db: db as HubDb },
      startOpts,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(404);
    expect(rows.size).toBe(0);
  });

  test("CL-2885: a member-role deny blocks the run with 403 and seeds no row (gate covers every caller: route AND agent tool)", async () => {
    reset();
    // biome-ignore lint/suspicious/noExplicitAny: structural test mock
    const db: any = {
      query: {
        workflowRun: { findMany: async () => [DEFINITION] },
        role: { findMany: async () => [{ id: "rol_member" }] },
        grant: {
          findMany: async () => [
            {
              id: "grt_deny",
              resource: "workflow:pain-point-collateral",
              action: "run",
              effect: "deny",
              origin: "role",
              conditions: null,
              expiresAt: null,
              roleId: "rol_member",
              principalId: null,
              tenantId: "tn-1",
            },
          ],
        },
      },
    };
    const result = await startWorkflowRun(
      { ...baseDeps(provisionOk), db: db as HubDb },
      startOpts,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(403);
    expect(rows.size).toBe(0); // gated before provisioning — no run started
    expect(sent).toHaveLength(0);
  });
});

// The generic start path (this same `startWorkflowRun`, shared by the
// HTTP /workflow-exec/:kind/start route and the workflow_start hub tool) has no
// heartbeat-specific knowledge of its own — a bare `{ ...input, runId }` sent
// straight to the deployment left every brief-source intake step's argMap
// dispatch failing on an absent `enabledSources`/`userDisplayName`, because
// only the scheduler and the heartbeat-specific manual-run route called
// `enrichHeartbeatTriggerPayload` themselves. These prove the registered
// "heartbeat" trigger-payload enricher (./trigger-payload-enrichment-registry)
// now applies uniformly through this one shared implementation.
describe("startWorkflowRun trigger-payload enrichment for a registered kind", () => {
  const HEARTBEAT_DEFINITION = {
    kind: "heartbeat",
    tenantId: "tn-1",
    deploymentId: "ses_dep_hb",
    principalId: "prn-deployer",
    createdAt: new Date(),
  };

  function makeHeartbeatDb(): HubDb {
    // biome-ignore lint/suspicious/noExplicitAny: structural test mock
    const db: any = {
      query: {
        workflowRun: { findMany: async () => [HEARTBEAT_DEFINITION] },
        role: { findMany: async () => [] },
        // No stored preferences yet — resolveEnabledBriefSources falls back to
        // each source's catalog default (currently all default-off).
        memberPreferences: { findFirst: async () => undefined },
      },
    };
    return db as HubDb;
  }

  test("a heartbeat run started with a bare body still gets enabledSources and userDisplayName", async () => {
    reset();
    const result = await startWorkflowRun(
      {
        ...baseDeps(provisionOk),
        db: makeHeartbeatDb(),
        resolveUserIdentity: async (principalId: string) => ({
          userAddress: `usr_${principalId}@wf.localhost`,
          userRefId: principalId,
          userDisplayName: "Jordan Lee",
        }),
      },
      {
        kind: "heartbeat",
        chain: ["tn-1"],
        principalId: "prn-1",
        input: {},
        originConversationId: null,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    await result.backgroundTask;

    const stored = insertedInputs.get(result.state.runId) as Record<
      string,
      unknown
    >;
    expect(stored.enabledSources).toEqual([]);
    expect(stored.userDisplayName).toBe("Jordan Lee");
    expect(stored.userAddress).toBe("usr_prn-1@wf.localhost");
    expect(typeof stored.createdAfter).toBe("string");
  });

  test("a kind with no registered enricher passes its input through unchanged", async () => {
    reset();
    const result = await startWorkflowRun(baseDeps(provisionOk), startOpts);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    await result.backgroundTask;

    const stored = insertedInputs.get(result.state.runId) as Record<
      string,
      unknown
    >;
    expect(stored).toEqual({ topic: "Acme", runId: result.state.runId });
    expect("enabledSources" in stored).toBe(false);
  });
});
