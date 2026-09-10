// CL-7584: the tenant desired-state document is client-side data — a
// plain const composed by reference over the existing single-source
// constants — and `readTenantDesiredStateStatus` reads a tenant's real
// state against it using native hub reads only.
import { describe, expect, test } from "bun:test";
import type { ApiCall } from "@corbits/hub-api-client";
import { SETUP_AGENT_ASSET_NAME } from "@corbits/seeding";
import {
  desiredStateSteps,
  readTenantDesiredStateStatus,
  TENANT_DESIRED_STATE,
} from "../src/desired-state";

const TENANT_ID = "ten_doc";
const TOOLS_ASSET_ID = "ast_corbits-tools";

function assetRow(tenantId: string, kind: string, name: string) {
  return {
    id: `ast_${name}`,
    tenantId,
    kind,
    name,
    displayName: null,
    creatorPrincipalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    origin: { tenantId, direct: true },
  };
}

type StubState = {
  workflowAssets?: boolean;
  liveDeployments?: boolean;
  registryTarballs?: boolean;
  skills?: boolean;
  failSkillReadsWith?: number;
};

function stubApi(state: StubState): ApiCall & { calls: [string, string][] } {
  const calls: [string, string][] = [];
  const call = (async (method: string, path: string): Promise<unknown> => {
    calls.push([method, path]);
    if (
      method === "GET" &&
      path === `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
    ) {
      return {
        status: 200,
        data: state.workflowAssets
          ? [assetRow(TENANT_ID, "workflow", SETUP_AGENT_ASSET_NAME)]
          : [],
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      path === `/api/tenants/${TENANT_ID}/workflows/deployments`
    ) {
      return {
        status: 200,
        data: state.liveDeployments && state.workflowAssets
          ? [
              {
                definitionAssetId: `ast_${SETUP_AGENT_ASSET_NAME}`,
                status: "deployed",
              },
            ]
          : [],
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      path ===
        `/api/tenants/${TENANT_ID}/assets?kind=package-registry&inherited=true`
    ) {
      return {
        status: 200,
        data: state.registryTarballs
          ? [assetRow(TENANT_ID, "package-registry", "corbits-tools")]
          : [],
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      path === `/api/tenants/${TENANT_ID}/assets/${TOOLS_ASSET_ID}/tarballs`
    ) {
      return {
        status: 200,
        data: state.registryTarballs
          ? [{ filename: "corbits-memory-tools-0.0.4.tgz", size: 1, integrity: "sha512-x" }]
          : [],
        cookies: [],
      };
    }
    if (method === "GET" && path.startsWith(`/api/tenants/${TENANT_ID}/skills/`)) {
      if (state.failSkillReadsWith !== undefined) {
        return { status: state.failSkillReadsWith, data: {}, cookies: [] };
      }
      return {
        status: state.skills === true ? 200 : 404,
        data: state.skills === true ? { name: "writing-system-prompts" } : {},
        cookies: [],
      };
    }
    throw new Error(`stub api: unhandled ${method} ${path}`);
  }) as unknown as ApiCall & { calls: [string, string][] };
  (call as unknown as { calls: [string, string][] }).calls = calls;
  return call;
}

describe("TENANT_DESIRED_STATE", () => {
  test("is a plain const composed by reference: Myra first, no DB in sight", () => {
    expect(TENANT_DESIRED_STATE.workflows.length).toBeGreaterThan(0);
    expect(TENANT_DESIRED_STATE.workflows[0]?.assetName).toBe(
      SETUP_AGENT_ASSET_NAME,
    );
    for (const pin of TENANT_DESIRED_STATE.workflows) {
      expect(typeof pin.assetName).toBe("string");
      expect(typeof pin.version).toBe("string");
      expect(typeof pin.definition).toBe("function");
    }
    for (const pin of TENANT_DESIRED_STATE.toolPackages) {
      expect(["workspace-pack", "tarball-url"]).toContain(pin.source.kind);
    }
    for (const pin of TENANT_DESIRED_STATE.skills) {
      expect(typeof pin.name).toBe("string");
      expect(typeof pin.body).toBe("string");
    }
  });
});

describe("readTenantDesiredStateStatus", () => {
  test("a fully converged tenant reports ready with every pin present", async () => {
    const api = stubApi({
      workflowAssets: true,
      liveDeployments: true,
      registryTarballs: true,
      skills: true,
    });
    const status = await readTenantDesiredStateStatus(api, [], TENANT_ID);
    expect(status.ready).toBe(true);
    expect(status.workflows[SETUP_AGENT_ASSET_NAME]).toBe("present");
    expect(status.tools).toBe("present");
    for (const skill of TENANT_DESIRED_STATE.skills) {
      expect(status.skills[skill.name]).toBe("present");
    }
  });

  test("a fresh tenant reports every pin pending", async () => {
    const api = stubApi({});
    const status = await readTenantDesiredStateStatus(api, [], TENANT_ID);
    expect(status.ready).toBe(false);
    expect(status.workflows[SETUP_AGENT_ASSET_NAME]).toBe("pending");
    expect(status.tools).toBe("pending");
    for (const skill of TENANT_DESIRED_STATE.skills) {
      expect(status.skills[skill.name]).toBe("pending");
    }
  });

  test("an asset without a live deployment is pending, not present", async () => {
    const api = stubApi({ workflowAssets: true, liveDeployments: false });
    const status = await readTenantDesiredStateStatus(api, [], TENANT_ID);
    expect(status.workflows[SETUP_AGENT_ASSET_NAME]).toBe("pending");
  });

  test("a skill read failure is blocked, not pending", async () => {
    const api = stubApi({ failSkillReadsWith: 502 });
    const status = await readTenantDesiredStateStatus(api, [], TENANT_ID);
    expect(status.skills[TENANT_DESIRED_STATE.skills[0]!.name]).toBe("blocked");
    expect(status.ready).toBe(false);
  });
});

describe("desiredStateSteps", () => {
  test("derives a labeled, doc-ordered step list from a status", async () => {
    const api = stubApi({ workflowAssets: true, liveDeployments: false });
    const status = await readTenantDesiredStateStatus(api, [], TENANT_ID);
    const steps = desiredStateSteps(status);
    expect(steps.length).toBe(
      TENANT_DESIRED_STATE.workflows.length +
        TENANT_DESIRED_STATE.toolPackages.length +
        TENANT_DESIRED_STATE.skills.length,
    );
    expect(steps[0]?.name).toBe(SETUP_AGENT_ASSET_NAME);
    expect(steps[0]?.status).toBe("pending");
    expect(typeof steps[0]?.label).toBe("string");
    expect(steps.every((s) => ["present", "pending", "blocked"].includes(s.status))).toBe(
      true,
    );
  });
});
