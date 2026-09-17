// CL-7584: `reconcileTenantDesiredState` installs ONLY absent pins, in
// order (tools, then skills + grants + workflows via `seedTenant`), and
// is idempotent — a second pass over a converged tenant issues zero
// non-GET calls. Sidecar-unavailable failures report `blocked` without
// throwing; anything else reports `failed` and is safe to re-run.
import { describe, expect, test } from "bun:test";
import type { ApiCall } from "@corbits/hub-api-client";
import { SidecarUnavailableError } from "@corbits/hub-api-client";
import type { ModelSource } from "../src/tenant-seed";
import type { WorkflowPusher } from "@corbits/connections/workflow-push";
import { installRegistryTarball } from "@corbits/tool-registry-publish";
import {
  reconcileTenantDesiredState,
  resolveTenantDeployer,
  resolveTenantModelSource,
  TENANT_DESIRED_STATE,
  type ReconcileArgs,
} from "../src/desired-state";

const TENANT_ID = "ten_reconcile";
const MODEL: ModelSource = { provider: "anthropic", model: "claude-x" };

const ASSISTANT_ASSET = {
  id: "ast_assistant",
  tenantId: TENANT_ID,
  kind: "workflow",
  name: "assistant",
  displayName: null,
  creatorPrincipalId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  origin: { tenantId: TENANT_ID, direct: true },
};
const REGISTRY_ASSET = {
  ...ASSISTANT_ASSET,
  id: "ast_corbits-tools",
  kind: "package-registry",
  name: "corbits-tools",
};

type Stub = {
  workflowAssets: boolean;
  liveDeployments: boolean;
  registryTarballs: boolean;
  skills: boolean;
  catalogOfferings: boolean;
};

function harness(state: Stub) {
  const calls: { method: string; path: string }[] = [];
  let seedTenantCalls = 0;
  const api = (async (method: string, path: string): Promise<unknown> => {
    calls.push({ method, path });
    if (
      method === "GET" &&
      path === `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
    ) {
      return {
        status: 200,
        data: state.workflowAssets ? [ASSISTANT_ASSET] : [],
        cookies: [],
      };
    }
    if (method === "GET" && path === `/api/tenants/${TENANT_ID}/workflows/deployments`) {
      return {
        status: 200,
        data:
          state.workflowAssets && state.liveDeployments
            ? [{ definitionAssetId: ASSISTANT_ASSET.id, status: "deployed" }]
            : [],
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      (path === `/api/tenants/${TENANT_ID}/assets?kind=package-registry&inherited=true` ||
        path === `/api/tenants/${TENANT_ID}/assets?kind=package-registry&inherited=false`)
    ) {
      return {
        status: 200,
        data: state.registryTarballs ? [REGISTRY_ASSET] : [],
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      path === `/api/tenants/${TENANT_ID}/assets/${REGISTRY_ASSET.id}/tarballs`
    ) {
      return {
        status: 200,
        data: state.registryTarballs
          ? [
              {
                filename: "corbits-capability-tools-0.0.6.tgz",
                size: 1,
                integrity: "sha512-x",
              },
            ]
          : [],
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      path === `/api/tenants/${TENANT_ID}/assets?kind=skill&inherited=false`
    ) {
      return {
        status: 200,
        data: state.skills
          ? TENANT_DESIRED_STATE.skills.map((skill, index) => ({
              id: `ast_skill_${index}`,
              tenantId: TENANT_ID,
              kind: "skill",
              name: skill.name,
              displayName: null,
              creatorPrincipalId: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              origin: { tenantId: TENANT_ID, direct: true },
            }))
          : [],
        cookies: [],
      };
    }
    if (method === "GET" && path === `/api/tenants/${TENANT_ID}/models`) {
      return {
        status: 200,
        data: state.catalogOfferings
          ? [
              {
                id: "mdl_1",
                canonicalName: "claude-x",
                offerings: [
                  {
                    offeringId: "off_1",
                    providerId: "prv_1",
                    providerName: "Anthropic",
                    plugin: "anthropic",
                    priority: 0,
                    deploymentTags: [],
                    capabilities: ["function-calling"],
                    pricing: [],
                  },
                ],
              },
            ]
          : [],
        cookies: [],
      };
    }
    if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
      // create-first: the registry asset is ensured here on the
      // tarball-url install path.
      return { status: 201, data: REGISTRY_ASSET, cookies: [] };
    }
    throw new Error(`stub api: unhandled ${method} ${path}`);
  }) as unknown as ApiCall;

  const pushWorkflow: WorkflowPusher = async (args) => {
    calls.push({ method: "PUSH", path: args.remoteUrl });
    return { outcome: "pushed", commitSha: "a".repeat(40) };
  };

  const args: ReconcileArgs = {
    api,
    cookies: ["session=1"],
    hubUrl: "https://hub.example.com",
    tenant: { tenantId: TENANT_ID, principalId: "prn_1", domain: "t.local" },
    model: MODEL,
    pushWorkflow,
    seedTenantFn: async (seedArgs) => {
      calls.push({ method: "SEED_TENANT", path: seedArgs.tenant.tenantId });
      seedTenantCalls += 1;
      state.workflowAssets = true;
      state.liveDeployments = true;
      state.skills = true;
    },
    log: () => undefined,
  };

  return {
    args,
    state,
    calls,
    nonGetCalls: () => calls.filter((c) => c.method !== "GET"),
    seedTenantCalls: () => seedTenantCalls,
  };
}

describe("reconcileTenantDesiredState", () => {
  test("a fresh tenant reports absent workspace-pack tools blocked (CL-8190: never packed here) while workflows still install", async () => {
    const h = harness({
      workflowAssets: false,
      liveDeployments: false,
      registryTarballs: false,
      skills: false,
      catalogOfferings: true,
    });
    const report = await reconcileTenantDesiredState(h.args);
    expect(report.ready).toBe(false);
    expect(h.seedTenantCalls()).toBe(1);
    const tools = report.pins.filter((p) => p.kind === "tool-package");
    expect(tools.every((p) => p.status === "blocked")).toBe(true);
    expect(h.nonGetCalls().some((c) => c.method === "PUBLISH")).toBe(false);
    expect(report.pins.filter((p) => p.kind === "workflow")).toEqual(
      TENANT_DESIRED_STATE.workflows.map((w) => ({
        name: w.assetName,
        kind: "workflow",
        status: "installed",
      })),
    );
    expect(report.pins.filter((p) => p.kind === "skill").length).toBe(
      TENANT_DESIRED_STATE.skills.length,
    );
  });

  test("SECOND PASS on a converged tenant issues ZERO non-GET calls", async () => {
    const h = harness({
      workflowAssets: true,
      liveDeployments: true,
      registryTarballs: true,
      skills: true,
      catalogOfferings: true,
    });
    // First pass over an already-converged tenant (the standalone proof:
    // everything present means nothing may write).
    const first = await reconcileTenantDesiredState(h.args);
    expect(first.ready).toBe(true);
    expect(h.seedTenantCalls()).toBe(0);
    expect(h.nonGetCalls().length).toBe(0);

    // And a fresh workflow/skill install (tools already present, as an
    // operator's out-of-band `bun run publish-tools` would leave them)
    // followed by a revisit behaves identically.
    const h2 = harness({
      workflowAssets: false,
      liveDeployments: false,
      registryTarballs: true,
      skills: false,
      catalogOfferings: true,
    });
    await reconcileTenantDesiredState(h2.args);
    const writesAfterFirst = h2.nonGetCalls().length;
    expect(writesAfterFirst).toBeGreaterThan(0);
    const second = await reconcileTenantDesiredState(h2.args);
    expect(second.ready).toBe(true);
    expect(second.pins.every((p) => p.status === "present")).toBe(true);
    expect(h2.nonGetCalls().length).toBe(writesAfterFirst);
  });

  test("a sidecar-unavailable deploy reports blocked without throwing", async () => {
    const h = harness({
      workflowAssets: false,
      liveDeployments: false,
      registryTarballs: true,
      skills: false,
      catalogOfferings: true,
    });
    h.args.seedTenantFn = async () => {
      throw new SidecarUnavailableError("sidecar unreachable", "retry later");
    };
    const report = await reconcileTenantDesiredState(h.args);
    expect(report.ready).toBe(false);
    expect(
      report.pins.filter((p) => p.kind === "workflow").every((p) => p.status === "blocked"),
    ).toBe(true);
  });

  test("no catalog offerings reports workflow pins blocked, not a throw", async () => {
    const h = harness({
      workflowAssets: false,
      liveDeployments: false,
      registryTarballs: true,
      skills: false,
      catalogOfferings: false,
    });
    // No offerings: the caller cannot resolve a model, so the deploy
    // half is blocked rather than attempted.
    h.args.model = undefined as unknown as ModelSource;
    const report = await reconcileTenantDesiredState(h.args);
    expect(report.ready).toBe(false);
    expect(
      report.pins.filter((p) => p.kind === "workflow").every((p) => p.status === "blocked"),
    ).toBe(true);
    expect(h.seedTenantCalls()).toBe(0);
  });

  test("a non-sidecar failure reports failed, and a re-run can converge", async () => {
    const h = harness({
      workflowAssets: false,
      liveDeployments: false,
      registryTarballs: true,
      skills: true,
      catalogOfferings: true,
    });
    let failing = true;
    h.args.seedTenantFn = async () => {
      if (failing) throw new Error("grant reconcile blew up");
      h.args.seedTenantFn = async () => undefined;
    };
    const first = await reconcileTenantDesiredState(h.args);
    expect(first.ready).toBe(false);
    expect(first.pins.some((p) => p.status === "failed")).toBe(true);

    failing = false;
    const second = await reconcileTenantDesiredState(h.args);
    expect(second.ready).toBe(true);
  });

  test("a tarball-url pin is fetched, integrity-verified, and PUT once", async () => {
    const h = harness({
      workflowAssets: true,
      liveDeployments: true,
      registryTarballs: false,
      skills: true,
      catalogOfferings: true,
    });
    const bytes = new TextEncoder().encode("fake-tarball-bytes");
    const putUrls: string[] = [];
    const outcome = await installRegistryTarball({
      api: h.args.api,
      cookies: [],
      hubUrl: "https://hub.example.com",
      tenantId: TENANT_ID,
      name: "@corbits/capability-tools",
      version: "0.0.6",
      fetchSource: async () => bytes,
      fetchImpl: async (input) => {
        putUrls.push(String(input));
        return Response.json({ commit: "c".repeat(40), integrity: "sha512-x" });
      },
      log: () => undefined,
    });
    expect(outcome).toBe("installed");
    expect(putUrls.length).toBe(1);
    expect(putUrls[0]).toContain(
      `/api/tenants/${TENANT_ID}/assets/${REGISTRY_ASSET.id}/tarballs/corbits-capability-tools-0.0.6.tgz`,
    );

    // And a republished same name@version is skipped (immutable). The
    // listing now carries the tarball the PUT above created.
    h.state.registryTarballs = true;
    const skipped = await installRegistryTarball({
      api: h.args.api,
      cookies: [],
      hubUrl: "https://hub.example.com",
      tenantId: TENANT_ID,
      name: "@corbits/capability-tools",
      version: "0.0.6",
      fetchSource: async () => bytes,
      fetchImpl: async () => {
        throw new Error("must not PUT over an existing name@version");
      },
      log: () => undefined,
    });
    expect(skipped).toBe("present");
  });
});

describe("resolveTenantModelSource", () => {
  test("picks the top-priority resolved offering", async () => {
    const h = harness({
      workflowAssets: true,
      liveDeployments: true,
      registryTarballs: true,
      skills: true,
      catalogOfferings: true,
    });
    const model = await resolveTenantModelSource(h.args.api, [], TENANT_ID);
    expect(model).toEqual({ provider: "anthropic", model: "claude-x" });
  });

  test("undefined when the tenant has no offerings", async () => {
    const h = harness({
      workflowAssets: true,
      liveDeployments: true,
      registryTarballs: true,
      skills: true,
      catalogOfferings: false,
    });
    const model = await resolveTenantModelSource(h.args.api, [], TENANT_ID);
    expect(model).toBeUndefined();
  });
});

describe("resolveTenantDeployer", () => {
  // The tenant-create kick (CL-7584) reconciles a tenant nobody has
  // connected a credential to yet, so there is no pending-seed row to
  // read deploy identity from — it resolves the creator's owner
  // principal plus the tenant domain straight from the API instead of
  // deploying under empty-string ids.
  function deployerPrincipalsPage(
    principals: {
      principalId: string;
      tenantId: string;
      kind?: string;
      status?: string;
    }[],
  ) {
    return {
      status: 200,
      data: {
        data: principals.map((p) => ({
          kind: "user",
          status: "active",
          roles: [],
          tenantName: p.tenantId,
          tenantSlug: p.tenantId,
          ...p,
        })),
        nextCursor: null,
      },
      cookies: [],
    };
  }

  function deployerTenant(domain: string) {
    return {
      status: 200,
      data: {
        id: "ten_child",
        name: "second",
        slug: "second",
        domain,
        parentId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      cookies: [],
    };
  }

  test("resolves the active user principal for the tenant id plus the tenant domain", async () => {
    const api = (async (method: string, path: string) => {
      if (method === "GET" && path === "/api/me/principals") {
        return deployerPrincipalsPage([
          { principalId: "prn_root", tenantId: "ten_root" },
          { principalId: "prn_child", tenantId: "ten_child" },
        ]);
      }
      if (method === "GET" && path === "/api/tenants/ten_child") {
        return deployerTenant("second.localhost");
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    }) as unknown as ApiCall;

    await expect(resolveTenantDeployer(api, ["session=abc"], "ten_child")).resolves.toEqual({
      tenantId: "ten_child",
      principalId: "prn_child",
      tenantDomain: "second.localhost",
    });
  });

  test("ignores suspended and non-user principals, resolving to nothing without reading the tenant", async () => {
    const api = (async (method: string, path: string) => {
      if (method === "GET" && path === "/api/me/principals") {
        return deployerPrincipalsPage([
          { principalId: "prn_root", tenantId: "ten_root" },
          {
            principalId: "prn_suspended",
            tenantId: "ten_child",
            status: "suspended",
          },
          { principalId: "prn_agent", tenantId: "ten_child", kind: "agent" },
        ]);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    }) as unknown as ApiCall;

    await expect(resolveTenantDeployer(api, ["session=abc"], "ten_child")).resolves.toBeUndefined();
  });

  test("zero principals resolves to nothing without reading the tenant", async () => {
    const api = (async (method: string, path: string) => {
      if (method === "GET" && path === "/api/me/principals") {
        return deployerPrincipalsPage([]);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    }) as unknown as ApiCall;

    await expect(resolveTenantDeployer(api, ["session=abc"], "ten_child")).resolves.toBeUndefined();
  });
});
