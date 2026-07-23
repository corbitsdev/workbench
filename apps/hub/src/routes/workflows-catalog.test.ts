import { describe, expect, it } from "bun:test";
import { mock } from "bun:test";
import { DETERMINISTIC_TOOL_KIND, STEP_KIND_TAG } from "@workbench/agents";

let userContext: {
  context: { tenantId: string; principalId: string } | null;
  forbidden: boolean;
} = {
  context: { tenantId: "t1", principalId: "p1" },
  forbidden: false,
};
mock.module("../lib/user-context", () => ({
  getRequestedUserContext: () => Promise.resolve(userContext),
}));

const intxDbReal = await import("@intx/db");
mock.module("@intx/db", () => ({
  ...intxDbReal,
  getAncestorChain: () => Promise.resolve(["t1"]),
}));

let kinds: { kind: string; label?: string; description?: string }[] = [];
mock.module("../lib/workflow-run-gate", () => ({
  listRunnableWorkflowDeployments: () => Promise.resolve([]),
  distinctRunnableKindsFromDeployments: () => kinds,
}));

// A two-step definition: one deterministic (auto) step then one human gate.
function definitionFor(kind: string) {
  if (kind === "broken") throw new Error("workflow.json missing");
  return {
    id: kind,
    triggers: [],
    stepOrder: ["gather", "approve"],
    steps: {
      gather: {
        kind: "step",
        id: "gather",
        agent: { id: "a", tags: { [STEP_KIND_TAG]: DETERMINISTIC_TOOL_KIND } },
      },
      approve: { kind: "awaitSignal", id: "approve", name: "approve draft" },
    },
  };
}
mock.module("../services/workflow-deploy", () => ({
  readWorkflowDefinition: (_repoStore: unknown, kind: string) =>
    Promise.resolve(definitionFor(kind)),
}));

let favorites: string[] = [];
mock.module("../lib/member-preferences", () => ({
  readMemberPreferences: () =>
    Promise.resolve({ favoriteWorkflows: favorites }),
}));
mock.module("../lib/tenant-provisioning", () => ({
  getRootTenantId: () => Promise.resolve("t-root"),
  lookupMember: () =>
    Promise.resolve({ tenantId: "t-root", principalId: "p1" }),
}));

// Gate shape per kind (CL-3508 + product allowlist CL-4204). Unattended kinds
// are structurally attachable; attachable on the wire also requires product
// eligibility (heartbeat / prospect-engine / last30days-research only).
let gateInfos = new Map<
  string,
  { requiresIntake: boolean; humanGateCount: number }
>([
  ["heartbeat", { requiresIntake: false, humanGateCount: 0 }],
  ["deck", { requiresIntake: false, humanGateCount: 0 }],
  ["last30days-research", { requiresIntake: true, humanGateCount: 1 }],
]);
mock.module("../lib/workflow-catalog", () => ({
  loadWorkflowDisplayFlows: async () => new Map(),
  loadWorkflowGateInfos: async () => gateInfos,
  loadWorkflowIntakeFields: async () => new Map(),
}));

import { Hono } from "hono";
import { createWorkflowsCatalogRouter } from "./workflows-catalog";
import type { HubDb } from "../db";
import type { AgentRepoStore } from "@workbench/hub-sessions";

function app() {
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
  return parent;
}

function get() {
  return app().request(
    new Request("http://local/workflows", { method: "GET" }),
  );
}

type Entry = {
  kind: string;
  label: string;
  isFavorite: boolean;
  stepCount: number;
  pauseCount: number;
  steps: { id: string; title: string; kind: string }[];
  attachable?: boolean;
};

describe("GET /workflows", () => {
  it("returns each kind with classified steps and pause counts", async () => {
    userContext = {
      context: { tenantId: "t1", principalId: "p1" },
      forbidden: false,
    };
    favorites = [];
    kinds = [{ kind: "alpha", label: "Alpha", description: "First" }];

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Entry[] };
    const alpha = body.entries[0]!;
    expect(alpha).toMatchObject({
      kind: "alpha",
      label: "Alpha",
      description: "First",
      isFavorite: false,
      stepCount: 2,
      pauseCount: 1,
    });
    expect(alpha.steps).toEqual([
      { id: "gather", title: "Gather", kind: "auto" },
      { id: "approve", title: "Approve Draft", kind: "human" },
    ]);
  });

  it("pins favorited kinds first and marks isFavorite", async () => {
    userContext = {
      context: { tenantId: "t1", principalId: "p1" },
      forbidden: false,
    };
    favorites = ["zeta"];
    kinds = [
      { kind: "alpha", label: "Alpha" },
      { kind: "zeta", label: "Zeta" },
    ];

    const body = (await (await get()).json()) as { entries: Entry[] };
    expect(body.entries.map((e) => e.kind)).toEqual(["zeta", "alpha"]);
    expect(body.entries[0]!.isFavorite).toBe(true);
    expect(body.entries[1]!.isFavorite).toBe(false);
  });

  it("keeps a kind whose definition is unreadable but gives it no steps", async () => {
    userContext = {
      context: { tenantId: "t1", principalId: "p1" },
      forbidden: false,
    };
    favorites = [];
    kinds = [{ kind: "broken", label: "Broken" }];

    const body = (await (await get()).json()) as { entries: Entry[] };
    expect(body.entries[0]).toMatchObject({
      kind: "broken",
      stepCount: 0,
      pauseCount: 0,
    });
    expect(body.entries[0]!.steps).toEqual([]);
  });

  it("falls back to a humanized label when the deployment has none", async () => {
    userContext = {
      context: { tenantId: "t1", principalId: "p1" },
      forbidden: false,
    };
    favorites = [];
    kinds = [{ kind: "last30days_research" }];

    const body = (await (await get()).json()) as { entries: Entry[] };
    expect(body.entries[0]!.label).toBe("Last30days Research");
  });

  it("403s when there is no user context", async () => {
    userContext = { context: null, forbidden: false };
    const res = await get();
    expect(res.status).toBe(403);
  });

  it("marks attachable only when structural AND product-eligible (CL-4204)", async () => {
    userContext = {
      context: { tenantId: "t1", principalId: "p1" },
      forbidden: false,
    };
    favorites = [];
    kinds = [
      { kind: "heartbeat", label: "Heartbeat" },
      { kind: "deck", label: "Deck" },
      { kind: "alpha", label: "Alpha" },
    ];

    const body = (await (await get()).json()) as { entries: Entry[] };
    const byKind = Object.fromEntries(body.entries.map((e) => [e.kind, e]));
    // Product-eligible + structurally attachable
    expect(byKind["heartbeat"]!.attachable).toBe(true);
    // Structurally attachable but not on the product allowlist
    expect(byKind["deck"]!.attachable).toBe(false);
    // No gate info → not attachable
    expect(byKind["alpha"]!.attachable).toBe(false);
  });
});
