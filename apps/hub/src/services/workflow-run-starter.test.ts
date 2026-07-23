import { describe, expect, it } from "bun:test";
import { mock } from "bun:test";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import * as intxDb from "@intx/db";
import type { SessionService } from "@workbench/hub-sessions";
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
  status: string;
  createdAt: Date;
  deletedAt: Date | null;
};

type MakeDbOptions = {
  /** When true, setRunDeployment's update throws after recording the id. */
  throwOnSetDeployment?: boolean;
  /** failRunIfStillProvisioning return: empty = flip lost (projection won). */
  failFlipRows?: Array<{ id: string }>;
};

type TestDb = HubDb & {
  inserted: Record<string, unknown>[];
  failUpdateCalls: number;
  deploymentIdSets: string[];
};

function makeDb(candidates: Candidate[], options: MakeDbOptions = {}): TestDb {
  const inserted: Record<string, unknown>[] = [];
  let failUpdateCalls = 0;
  const deploymentIdSets: string[] = [];
  const failFlipRows = options.failFlipRows ?? [{ id: "flipped" }];
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
      set: (vals: Record<string, unknown>) => {
        if (typeof vals.deploymentId === "string") {
          deploymentIdSets.push(vals.deploymentId);
          if (options.throwOnSetDeployment) {
            return {
              where: () => Promise.reject(new Error("attach write failed")),
            };
          }
        }
        // Thenable query builder: setRunDeployment awaits where() directly;
        // failRunIfStillProvisioning awaits where().returning().
        return {
          where: () => ({
            then(
              onFulfilled?: (v: unknown) => unknown,
              onRejected?: (e: unknown) => unknown,
            ) {
              return Promise.resolve(undefined).then(onFulfilled, onRejected);
            },
            returning: async () => {
              failUpdateCalls += 1;
              return failFlipRows;
            },
          }),
        };
      },
    }),
    inserted,
    deploymentIdSets,
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
    deploymentId: "dep-catalog-1",
    kind: "generic-workflow",
    tenantId: "t-root",
    principalId: "principal-1",
    status: "deployed",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

function starterDeps(overrides: {
  db: TestDb;
  sessionService?: SessionService;
  provisionRunDeployment?: (a: {
    kind: string;
    tenantId: string;
    creatorPrincipalId: string;
  }) => Promise<{ deploymentId: string }>;
  reclaimDeployment?: (a: {
    deploymentId: string;
    tenantId: string;
    reason: string;
  }) => Promise<void>;
  now?: () => number;
  resolveUserIdentity?: typeof resolveUserIdentity;
}) {
  return {
    db: overrides.db,
    sessionService:
      overrides.sessionService ??
      ({
        sendUserMessage: async () => {},
      } as unknown as SessionService),
    provisionRunDeployment:
      overrides.provisionRunDeployment ??
      (async () => ({ deploymentId: "dep-run-fresh" })),
    deploymentDomain: DOMAIN,
    cryptoProvider: {} as never,
    resolveUserIdentity: overrides.resolveUserIdentity ?? resolveUserIdentity,
    ...(overrides.reclaimDeployment
      ? { reclaimDeployment: overrides.reclaimDeployment }
      : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  };
}

describe("createWorkflowRunStarter", () => {
  it("selects the most-specific catalog definition, provisions a fresh deploy, and delivers to it", async () => {
    chainRef = ["t-child", "t-root"];
    const sent: Record<string, unknown>[] = [];
    const provisionArgs: Record<string, unknown>[] = [];
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
    const starter = createWorkflowRunStarter(
      starterDeps({
        db,
        sessionService,
        provisionRunDeployment: async (a) => {
          provisionArgs.push(a);
          return { deploymentId: "dep-run-1" };
        },
      }),
    );

    const input = { reason: "scheduled-heartbeat" };
    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-child",
      input,
    });

    expect(result.ok).toBe(true);
    // Per-run deploy id — NOT the catalog's dep-child (CL-4069).
    expect(result).toMatchObject({ ok: true, deploymentId: "dep-run-1" });
    if (!result.ok) throw new Error("expected ok result");
    expect(isUuid(result.runId)).toBe(true);
    expect(provisionArgs).toEqual([
      {
        kind: "generic-workflow",
        tenantId: "t-child",
        creatorPrincipalId: "principal-child",
      },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.agentAddress).toBe(
      deriveDeploymentAddress({
        deploymentId: "dep-run-1",
        deploymentDomain: DOMAIN,
      }),
    );
    expect(sent[0]?.content).toBe(
      JSON.stringify({ ...input, runId: result.runId }),
    );
    expect(sent[0]?.tenantId).toBe("t-child");
    expect(sent[0]?.from).toBe(`hub@${DOMAIN}`);
    expect(db.inserted).toHaveLength(1);
    // Durable-first: insert with null deployment, then setRunDeployment attaches.
    expect(db.inserted[0]?.deploymentId).toBeNull();
    expect(db.inserted[0]?.status).toBe("provisioning");
    expect(db.deploymentIdSets).toEqual(["dep-run-1"]);
    expect(sent[0]?.messageId).toBe(db.inserted[0]?.id);
  });

  it("returns not_found when no candidate is deployed for the kind", async () => {
    chainRef = ["t-root"];
    const starter = createWorkflowRunStarter(
      starterDeps({
        db: makeDb([]),
        sessionService: {
          sendUserMessage: async () => {
            throw new Error("must not deliver");
          },
        } as unknown as SessionService,
        provisionRunDeployment: async () => {
          throw new Error("must not provision");
        },
      }),
    );

    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  it("provisions a fresh deploy before delivering (CL-4069 pin path)", async () => {
    chainRef = ["t-root"];
    const sequence: string[] = [];
    let provisionArgs: Record<string, unknown> | undefined;
    const sessionService = {
      sendUserMessage: async () => {
        sequence.push("send");
      },
    } as unknown as SessionService;

    const starter = createWorkflowRunStarter(
      starterDeps({
        db: makeDb([
          candidate({ deploymentId: "dep-catalog", principalId: "creator-9" }),
        ]),
        sessionService,
        provisionRunDeployment: async (a) => {
          sequence.push("provision");
          provisionArgs = a;
          return { deploymentId: "dep-run-fresh" };
        },
      }),
    );

    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });

    expect(result.ok).toBe(true);
    expect(sequence).toEqual(["provision", "send"]);
    // Provision uses the catalog definition's principal (deployer), not a
    // schedule-owner override — matches startWorkflowRun / provisionRunDeployment.
    expect(provisionArgs).toEqual({
      kind: "generic-workflow",
      tenantId: "t-root",
      creatorPrincipalId: "creator-9",
    });
  });

  it("attributes the run to an explicit creatorPrincipalId while provisioning with the catalog principal", async () => {
    chainRef = ["t-root"];
    let provisionArgs: Record<string, unknown> | undefined;
    const db = makeDb([
      candidate({ deploymentId: "dep-1", principalId: "deployment-owner" }),
    ]);
    const starter = createWorkflowRunStarter(
      starterDeps({
        db,
        provisionRunDeployment: async (a) => {
          provisionArgs = a;
          return { deploymentId: "dep-run-2" };
        },
      }),
    );

    await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
      creatorPrincipalId: "schedule-owner",
    });

    expect(provisionArgs?.creatorPrincipalId).toBe("deployment-owner");
    expect(db.inserted[0]?.principalId).toBe("schedule-owner");
  });

  it("returns provision_failed when provision throws", async () => {
    chainRef = ["t-root"];
    const db = makeDb([candidate({ deploymentId: "dep-1" })]);
    const starter = createWorkflowRunStarter(
      starterDeps({
        db,
        provisionRunDeployment: async () => {
          throw new Error("package registry empty");
        },
      }),
    );

    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("provision_failed");
    expect(db.inserted).toHaveLength(1);
    expect(db.failUpdateCalls).toBe(1);
  });

  it("returns delivery_failed when delivery throws and reclaims the provisioned deploy", async () => {
    chainRef = ["t-root"];
    const db = makeDb([candidate({ deploymentId: "dep-1" })]);
    const reclaimed: Record<string, unknown>[] = [];
    const starter = createWorkflowRunStarter(
      starterDeps({
        db,
        sessionService: {
          sendUserMessage: async () => {
            throw new Error("sidecar unreachable");
          },
        } as unknown as SessionService,
        provisionRunDeployment: async () => ({ deploymentId: "dep-run-3" }),
        reclaimDeployment: async (a) => {
          reclaimed.push(a);
        },
      }),
    );

    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("delivery_failed");
    expect(db.inserted).toHaveLength(1);
    expect(db.failUpdateCalls).toBe(1);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.deploymentId).toBe("dep-run-3");
    expect(reclaimed[0]?.tenantId).toBe("t-root");
    expect(String(reclaimed[0]?.reason)).toContain("delivery failed");
  });

  it("does not reclaim when delivery fails but the fail flip loses to projection", async () => {
    chainRef = ["t-root"];
    const db = makeDb([candidate({ deploymentId: "dep-1" })], {
      failFlipRows: [],
    });
    const reclaimed: Record<string, unknown>[] = [];
    const starter = createWorkflowRunStarter(
      starterDeps({
        db,
        sessionService: {
          sendUserMessage: async () => {
            throw new Error("sidecar unreachable");
          },
        } as unknown as SessionService,
        provisionRunDeployment: async () => ({ deploymentId: "dep-run-live" }),
        reclaimDeployment: async (a) => {
          reclaimed.push(a);
        },
      }),
    );

    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("delivery_failed");
    expect(db.failUpdateCalls).toBe(1);
    expect(reclaimed).toHaveLength(0);
  });

  it("returns attach_failed and reclaims when setRunDeployment throws", async () => {
    chainRef = ["t-root"];
    const db = makeDb([candidate({ deploymentId: "dep-1" })], {
      throwOnSetDeployment: true,
    });
    const reclaimed: Record<string, unknown>[] = [];
    const starter = createWorkflowRunStarter(
      starterDeps({
        db,
        sessionService: {
          sendUserMessage: async () => {
            throw new Error("must not deliver after attach failure");
          },
        } as unknown as SessionService,
        provisionRunDeployment: async () => ({
          deploymentId: "dep-run-attach",
        }),
        reclaimDeployment: async (a) => {
          reclaimed.push(a);
        },
      }),
    );

    const result = await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("attach_failed");
    expect(db.deploymentIdSets).toEqual(["dep-run-attach"]);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.deploymentId).toBe("dep-run-attach");
    expect(String(reclaimed[0]?.reason)).toContain("attach failed");
  });

  it("starts runs while under the per-tenant hourly budget", async () => {
    chainRef = ["t-root"];
    const starter = createWorkflowRunStarter(
      starterDeps({
        db: makeDb([candidate({ deploymentId: "dep-1" })]),
        now: () => 1_000,
      }),
    );

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
    const starter = createWorkflowRunStarter(
      starterDeps({
        db: makeDb([candidate({ deploymentId: "dep-1" })]),
        sessionService: {
          sendUserMessage: async () => {
            sends += 1;
          },
        } as unknown as SessionService,
        now: () => 1_000,
      }),
    );

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
    const starter = createWorkflowRunStarter(
      starterDeps({
        db: makeDb([candidate({ deploymentId: "dep-1" })]),
        sessionService: {
          sendUserMessage: async () => {
            sends += 1;
          },
        } as unknown as SessionService,
        now: () => 1_000,
      }),
    );

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
    const starter = createWorkflowRunStarter(
      starterDeps({
        db: makeDb([candidate({ deploymentId: "dep-1" })]),
        now: () => clock,
      }),
    );

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
    const starter = createWorkflowRunStarter(
      starterDeps({
        db,
        now: () => 1_000,
      }),
    );

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

  // This starter backs every non-generic start door — webhook triggers
  // (../routes/webhook-trigger-fire.ts), the scheduler (apps/hub/src/index.ts),
  // and the heartbeat manual-run route (../routes/me-brief-run.ts) — none of
  // which build their own trigger-payload enrichment anymore. It must apply
  // the same kind-registered enrichment run-exec.ts's startWorkflowRun does,
  // not skip it because it delivers via a different code path.
  it("a webhook-fired heartbeat run gets enabledSources, identity, and createdAfter — not just whatever the webhook payload carried", async () => {
    chainRef = ["t-root"];
    const sent: Record<string, unknown>[] = [];
    const sessionService = {
      sendUserMessage: async (a: Record<string, unknown>) => {
        sent.push(a);
      },
    } as unknown as SessionService;

    const starter = createWorkflowRunStarter(
      starterDeps({
        db: makeDb([candidate({ deploymentId: "dep-1", kind: "heartbeat" })]),
        sessionService,
        resolveUserIdentity: async (principalId: string) => ({
          userAddress: `usr_${principalId}@${DOMAIN}`,
          userRefId: principalId,
          userDisplayName: "Jordan Lee",
        }),
      }),
    );

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

    const starter = createWorkflowRunStarter(
      starterDeps({
        db: makeDb([
          candidate({ deploymentId: "dep-1", kind: "generic-workflow" }),
        ]),
        sessionService,
      }),
    );

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

  // BLOCKING (review): the scheduler closure (apps/hub/src/index.ts) used to
  // pre-enrich with its real fire-time window BEFORE calling startRun; once
  // startRun started applying its own (hardcoded manual-refresh) enrichment
  // unconditionally, that pre-enrichment got silently overwritten — every
  // scheduled daily fire's createdAfter collapsed to the flat 7-day lookback,
  // defeating computeHeartbeatCreatedAfter's "day 2+ never re-briefs since
  // yesterday" contract and duplicating call coverage forever. `startRun`'s
  // `heartbeatFire` field is how the scheduler forwards its real
  // lastFiredDayUtc/hourUtc through to the registry; this drives that path
  // through the REAL starter (not a re-implementation) and asserts the
  // delivered createdAfter is the incremental since-yesterday window, not the
  // 7-day fallback.
  it("a scheduler-sourced heartbeat run gets the incremental since-last-fire createdAfter, not the 7-day manual-refresh fallback", async () => {
    chainRef = ["t-root"];
    const sent: Record<string, unknown>[] = [];
    const sessionService = {
      sendUserMessage: async (a: Record<string, unknown>) => {
        sent.push(a);
      },
    } as unknown as SessionService;
    const nowMs = Date.UTC(2026, 0, 9, 13, 0, 0);
    const today = Math.floor(nowMs / 86_400_000);
    const yesterday = today - 1;

    const starter = createWorkflowRunStarter(
      starterDeps({
        db: makeDb([candidate({ deploymentId: "dep-1", kind: "heartbeat" })]),
        sessionService,
        resolveUserIdentity: async (principalId: string) => ({
          userAddress: `usr_${principalId}@${DOMAIN}`,
          userRefId: principalId,
        }),
        now: () => nowMs,
      }),
    );

    const result = await starter.startRun({
      kind: "heartbeat",
      tenantId: "t-root",
      input: { reason: "scheduled-heartbeat" },
      creatorPrincipalId: "prn-owner",
      source: "scheduler",
      heartbeatFire: { lastFiredDayUtc: yesterday, hourUtc: 9 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const delivered = JSON.parse(sent[0]?.content as string) as Record<
      string,
      unknown
    >;
    const sevenDayFallback = new Date(nowMs - 7 * 86_400_000).toISOString();
    const incrementalWindow = new Date(
      yesterday * 86_400_000 + 9 * 3_600_000,
    ).toISOString();
    expect(delivered.createdAfter).toBe(incrementalWindow);
    expect(delivered.createdAfter).not.toBe(sevenDayFallback);
  });

  it("marks scheduler-sourced starts with triggerSource=scheduler on the run row", async () => {
    chainRef = ["t-root"];
    const db = makeDb([candidate({ deploymentId: "dep-1" })]);
    const starter = createWorkflowRunStarter(starterDeps({ db }));

    await starter.startRun({
      kind: "generic-workflow",
      tenantId: "t-root",
      input: {},
      source: "scheduler",
    });

    expect(db.inserted[0]?.triggerSource).toBe("scheduler");
  });
});
