// Integration seam: the REAL production catalog path for a flow-declaring
// workflow returns the GROUPED, labelled preview — identical to what the run
// stepper shows. This exercises the committed embedded def (which carries the
// declared displayFlow), the route's flow loader, and the real
// classifyWorkflowSteps together; only the repo-store read and auth plumbing are
// stubbed. A plain unit test that hand-feeds displayFlow to the classifier would
// not catch the wiring gap this guards (the declaration never reaching the
// server).

import { describe, expect, it, mock } from "bun:test";
import type { WorkflowDefinition } from "@intx/workflow";
import { resolveWorkflowEntry } from "../../bin/deploy-workflow";

type DeclaredDisplayStep = {
  key: string;
  label: string;
  stepIds: readonly string[];
};
type WorkflowModule = {
  workflow: WorkflowDefinition;
  DISPLAY_STEPS: readonly DeclaredDisplayStep[];
};

async function loadWorkflowModule(kind: string): Promise<WorkflowModule> {
  const mod: unknown = await import(resolveWorkflowEntry(kind));
  return mod as WorkflowModule;
}

const reddit = await loadWorkflowModule("reddit-opportunity-scanner");
const gamma = await loadWorkflowModule("gamma-presentation-creator");

const definitionsByKind: Record<string, WorkflowDefinition> = {
  "reddit-opportunity-scanner": reddit.workflow,
  "gamma-presentation-creator": gamma.workflow,
};

mock.module("../lib/user-context", () => ({
  getRequestedUserContext: () =>
    Promise.resolve({
      context: { tenantId: "t1", principalId: "p1" },
      forbidden: false,
    }),
}));

const intxDbReal = await import("@intx/db");
mock.module("@intx/db", () => ({
  ...intxDbReal,
  getAncestorChain: () => Promise.resolve(["t1"]),
}));

let kinds: { kind: string; label?: string }[] = [];
mock.module("../lib/workflow-run-gate", () => ({
  listRunnableWorkflowDeployments: () => Promise.resolve([]),
  distinctRunnableKindsFromDeployments: () => kinds,
}));

// Return the REAL serialized definition for the kind — the same object the repo
// store would surface at runtime. The route pairs it with the displayFlow it
// loads from the committed embedded catalog.
mock.module("../services/workflow-deploy", () => ({
  readWorkflowDefinition: (_repoStore: unknown, kind: string) => {
    const def = definitionsByKind[kind];
    if (def === undefined) throw new Error(`no def for ${kind}`);
    return Promise.resolve(def);
  },
}));

mock.module("../lib/member-preferences", () => ({
  readMemberPreferences: () => Promise.resolve({ favoriteWorkflows: [] }),
}));
mock.module("../lib/tenant-provisioning", () => ({
  getRootTenantId: () => Promise.resolve("t-root"),
  lookupMember: () =>
    Promise.resolve({ tenantId: "t-root", principalId: "p1" }),
}));

const { Hono } = await import("hono");
const { createWorkflowsCatalogRouter } = await import("./workflows-catalog");
import type { HubDb } from "../db";
import type { AgentRepoStore } from "@intx/hub-sessions";

type Entry = {
  kind: string;
  stepCount: number;
  steps: { id: string; title: string; kind: string }[];
};

async function fetchEntries(): Promise<Entry[]> {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  parent.route(
    "/",
    createWorkflowsCatalogRouter({
      db: {} as unknown as HubDb,
      repoStore: {} as unknown as AgentRepoStore,
    }),
  );
  const res = await parent.request(
    new Request("http://local/workflows", { method: "GET" }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { entries: Entry[] }).entries;
}

describe("GET /workflows — declared display flow drives the preview", () => {
  it("returns reddit's grouped, labelled preview from the production path", async () => {
    kinds = [{ kind: "reddit-opportunity-scanner", label: "Reddit" }];
    const [entry] = await fetchEntries();

    expect(entry!.steps.map((s) => s.title)).toEqual(
      reddit.DISPLAY_STEPS.map((g) => g.label),
    );
    expect(entry!.steps.map((s) => s.id)).toEqual(
      reddit.DISPLAY_STEPS.map((g) => g.key),
    );
    expect(entry!.stepCount).toBe(reddit.DISPLAY_STEPS.length);
  });

  it("collapses gamma's many runtime steps into its four declared groups", async () => {
    kinds = [{ kind: "gamma-presentation-creator", label: "Gamma" }];
    const [entry] = await fetchEntries();

    expect(entry!.steps.map((s) => s.title)).toEqual(
      gamma.DISPLAY_STEPS.map((g) => g.label),
    );
    // The preview is genuinely grouped: fewer entries than runtime steps.
    expect(entry!.steps.length).toBeLessThan(gamma.workflow.stepOrder.length);
    expect(entry!.steps.length).toBe(gamma.DISPLAY_STEPS.length);
  });
});
