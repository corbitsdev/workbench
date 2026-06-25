import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@intx/workflow";
import type { AgentRepoStore } from "@intx/hub-sessions";
import { LiveDeploymentsResponse } from "@workbench/tool-credentials";
import { type } from "arktype";
import { createInternalDeploymentsRouter } from "./internal-deployments";
import type { readWorkflowDefinition } from "../services/workflow-deploy";

const DOMAIN = "abklabs.com";

// Seed rows the fake db's select chain yields. Only live rows (deletedAt
// IS NULL + non-null deploymentId) should appear; the route's WHERE clause
// is what we assert filters them, so the fake applies the same predicate.
type Row = {
  deploymentId: string | null;
  kind: string;
  deletedAt: Date | null;
};

// An in-flight workflow_run_record: deployment id + status. The route's
// second query filters on status IN (running, awaiting) AND deletedAt IS NULL.
type RunRecord = {
  deploymentId: string;
  status: "running" | "awaiting" | "completed" | "failed";
};

// An agentInstance row. The route's third query selects addresses where
// endedAt IS NULL.
type AgentInstanceRow = {
  address: string;
  endedAt: Date | null;
};

// The route issues THREE select chains: (1) workflow_run live deployments,
// (2) workflow_run_record in-flight runs, (3) agent_instance live addresses.
// The fake serves them in call order — the route reads them sequentially.
function fakeDb(
  rows: Row[],
  runRecords: RunRecord[] = [],
  agentInstances: AgentInstanceRow[] = [],
) {
  const live = rows.filter(
    (r) => r.deploymentId !== null && r.deletedAt === null,
  );
  const activeRuns = runRecords
    .filter((r) => r.status === "running" || r.status === "awaiting")
    .map((r) => ({ deploymentId: r.deploymentId }));
  const liveAddresses = agentInstances
    .filter((a) => a.endedAt === null)
    .map((a) => ({ address: a.address }));
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => {
          let result: unknown[];
          if (call === 0) {
            result = live.map((r) => ({
              deploymentId: r.deploymentId,
              kind: r.kind,
            }));
          } else if (call === 1) {
            result = activeRuns;
          } else {
            result = liveAddresses;
          }
          call += 1;
          return result;
        },
      }),
    }),
  } as unknown as Parameters<typeof createInternalDeploymentsRouter>[0];
}

function defWithSteps(stepOrder: string[]): WorkflowDefinition {
  return { id: "wf", stepOrder } as unknown as WorkflowDefinition;
}

function makeRouter(opts: {
  rows: Row[];
  runRecords?: RunRecord[];
  agentInstances?: AgentInstanceRow[];
  definitions?: Record<string, WorkflowDefinition>;
  readThrows?: boolean;
}) {
  const read = (async (_store: AgentRepoStore, kind: string) => {
    if (opts.readThrows) throw new Error("missing workflow.json");
    return opts.definitions?.[kind] ?? defWithSteps(["plan", "execute"]);
  }) as unknown as typeof readWorkflowDefinition;
  return createInternalDeploymentsRouter(
    fakeDb(opts.rows, opts.runRecords, opts.agentInstances),
    "sidecar-token",
    {} as unknown as AgentRepoStore,
    DOMAIN,
    read,
  );
}

async function get(
  router: ReturnType<typeof createInternalDeploymentsRouter>,
  token = "sidecar-token",
): Promise<Response> {
  return router.request("/deployments/live", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("GET /deployments/live", () => {
  test("rejects an unauthorized caller", async () => {
    const res = await get(makeRouter({ rows: [] }), "wrong");
    expect(res.status).toBe(401);
  });

  test("returns only live deployments with derived addresses, slug, and step ids", async () => {
    const res = await get(
      makeRouter({
        rows: [
          { deploymentId: "ses_live", kind: "wf", deletedAt: null },
          { deploymentId: "ses_dead", kind: "wf", deletedAt: new Date() },
          { deploymentId: null, kind: "wf", deletedAt: null },
        ],
        definitions: { wf: defWithSteps(["plan", "execute"]) },
      }),
    );
    expect(res.status).toBe(200);
    const body = LiveDeploymentsResponse(await res.json());
    if (body instanceof type.errors) throw new Error(body.summary);

    expect(body.deployments).toHaveLength(1);
    const d = body.deployments[0]!;
    expect(d.deploymentId).toBe("ses_live");
    expect(d.supervisorAddress).toBe("ins_ses_live@abklabs.com");
    expect(d.supervisorAgentId).toBe("ins_ses_live");
    expect(d.workflowRunSlug).toBe("ins_ses_live-abklabs-com");
    expect(d.stepAgentIds).toEqual([
      "ins_ses_live-plan",
      "ins_ses_live-execute",
    ]);
    expect(d.stepAddresses).toEqual([
      "ins_ses_live-plan@abklabs.com",
      "ins_ses_live-execute@abklabs.com",
    ]);
    expect(d.agentStateRepoIds).toEqual(["ses_live-plan", "ses_live-execute"]);
  });

  test("fails loudly (500) when a live deployment definition cannot be read", async () => {
    const res = await get(
      makeRouter({
        rows: [{ deploymentId: "ses_live", kind: "wf", deletedAt: null }],
        readThrows: true,
      }),
    );
    expect(res.status).toBe(500);
  });

  test("activeRunDeploymentIds reflects only deployments with a running/awaiting record", async () => {
    const res = await get(
      makeRouter({
        rows: [
          { deploymentId: "ses_run", kind: "wf", deletedAt: null },
          { deploymentId: "ses_await", kind: "wf", deletedAt: null },
          { deploymentId: "ses_done", kind: "wf", deletedAt: null },
        ],
        runRecords: [
          { deploymentId: "ses_run", status: "running" },
          // a second running record for the same deployment must dedupe
          { deploymentId: "ses_run", status: "running" },
          { deploymentId: "ses_await", status: "awaiting" },
          // terminal records must NOT appear in the active set
          { deploymentId: "ses_done", status: "completed" },
          { deploymentId: "ses_done", status: "failed" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = LiveDeploymentsResponse(await res.json());
    if (body instanceof type.errors) throw new Error(body.summary);

    expect(body.deployments).toHaveLength(3);
    expect([...body.activeRunDeploymentIds].sort()).toEqual([
      "ses_await",
      "ses_run",
    ]);
  });

  test("activeRunDeploymentIds is empty when all runs are terminal", async () => {
    const res = await get(
      makeRouter({
        rows: [{ deploymentId: "ses_live", kind: "wf", deletedAt: null }],
        runRecords: [{ deploymentId: "ses_live", status: "completed" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = LiveDeploymentsResponse(await res.json());
    if (body instanceof type.errors) throw new Error(body.summary);
    expect(body.activeRunDeploymentIds).toEqual([]);
  });

  test("returns an empty set when there are no live deployments", async () => {
    const res = await get(
      makeRouter({
        rows: [{ deploymentId: "ses_dead", kind: "wf", deletedAt: new Date() }],
      }),
    );
    expect(res.status).toBe(200);
    const body = LiveDeploymentsResponse(await res.json());
    if (body instanceof type.errors) throw new Error(body.summary);
    expect(body.deployments).toEqual([]);
  });
});

describe("GET /deployments/live — liveAgentAddresses", () => {
  test("returns only non-ended agent instance addresses", async () => {
    const res = await get(
      makeRouter({
        rows: [],
        agentInstances: [
          { address: "ins_abc@gtm.localhost", endedAt: null },
          { address: "ins_def@gtm.localhost", endedAt: new Date() },
          { address: "ins_ghi@gtm.localhost", endedAt: null },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = LiveDeploymentsResponse(await res.json());
    if (body instanceof type.errors) throw new Error(body.summary);
    expect([...body.liveAgentAddresses].sort()).toEqual([
      "ins_abc@gtm.localhost",
      "ins_ghi@gtm.localhost",
    ]);
  });

  test("returns an empty liveAgentAddresses when all instances have ended", async () => {
    const res = await get(
      makeRouter({
        rows: [],
        agentInstances: [
          { address: "ins_abc@gtm.localhost", endedAt: new Date() },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = LiveDeploymentsResponse(await res.json());
    if (body instanceof type.errors) throw new Error(body.summary);
    expect(body.liveAgentAddresses).toEqual([]);
  });

  test("returns an empty liveAgentAddresses when there are no agent instances", async () => {
    const res = await get(makeRouter({ rows: [], agentInstances: [] }));
    expect(res.status).toBe(200);
    const body = LiveDeploymentsResponse(await res.json());
    if (body instanceof type.errors) throw new Error(body.summary);
    expect(body.liveAgentAddresses).toEqual([]);
  });
});
