import { describe, expect, test } from "bun:test";

import { buildNeedsList, childTenantStore } from "./needs-list";
import {
  convergeNeedsList,
  createFetchStockHub,
  deriveDesiredDirectMessages,
  StockHubCapabilityError,
  type HubSnapshot,
  type StockHub,
} from "./needs-converge";

const manifest = buildNeedsList({
  account: { id: "usr_1", email: "ada@example.com", name: "Ada" },
  myraDefinitionRefId: "assistant",
});

const primary = {
  id: "tnt_primary",
  name: "Ada",
  slug: "ada",
  parentId: null,
};

const myra = {
  id: "prn_myra",
  tenantId: "tnt_primary",
  kind: "workflow",
  refId: "run_myra",
  displayName: "Myra",
  status: "active",
  roles: [],
};

function snapshot(principals = [myra]): HubSnapshot {
  return {
    primaryTenant: primary,
    primaryPrincipals: [
      {
        id: "prn_user",
        tenantId: "tnt_primary",
        kind: "user",
        refId: "usr_1",
        displayName: "Ada",
        email: "ada@example.com",
        status: "active",
        roles: [{ id: "role_owner", name: "owner" }],
      },
      ...principals,
    ],
    childTenants: [],
    childPrincipals: {},
  };
}

function memoryStorage() {
  const rows = new Map<string, string>();
  return {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
  };
}

function noWriteHub(): StockHub {
  return {
    listMyPrincipals: () => Promise.resolve([]),
    getTenant: () => Promise.resolve(null),
    listPrincipals: () => Promise.resolve([]),
    createTenant: () => Promise.reject(new Error("unexpected create")),
    inviteMember: () => Promise.reject(new Error("unexpected invite")),
    deployWorkflow: () => Promise.reject(new Error("unexpected deploy")),
  };
}

describe("DM derivation", () => {
  test("derives exactly one chat child per active top-level workflow refId", () => {
    const desired = deriveDesiredDirectMessages(
      snapshot([
        myra,
        { ...myra, id: "prn_duplicate" },
        {
          ...myra,
          id: "prn_reviewer",
          refId: "run_reviewer",
          displayName: "Reviewer",
        },
        {
          ...myra,
          id: "prn_suspended",
          refId: "run_suspended",
          status: "suspended",
        },
      ]),
    );

    expect(desired).toEqual([
      {
        kind: "chat",
        localId: "dm:run_myra",
        name: "Myra",
        workflowRefId: "run_myra",
      },
      {
        kind: "chat",
        localId: "dm:run_reviewer",
        name: "Reviewer",
        workflowRefId: "run_reviewer",
      },
    ]);
  });

  test("fails before writes when stock Interchange cannot project the workflow principal", async () => {
    const store = childTenantStore(
      memoryStorage(),
      "https://hub.example",
      "usr_1",
    );
    try {
      await convergeNeedsList(manifest, noWriteHub(), store, snapshot());
      throw new Error("expected convergence to fail");
    } catch (cause) {
      expect(cause).toBeInstanceOf(StockHubCapabilityError);
      expect((cause as StockHubCapabilityError).capability).toBe(
        "project-workflow-principal",
      );
    }
    expect(store.load()).toEqual([]);
  });

  test("requires exact deployment inputs instead of guessing when Myra is absent", async () => {
    const store = childTenantStore(
      memoryStorage(),
      "https://hub.example",
      "usr_1",
    );
    await expect(
      convergeNeedsList(manifest, noWriteHub(), store, snapshot([])),
    ).rejects.toMatchObject({ capability: "deploy-workflow-inputs" });
  });
});

describe("fetch StockHub", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  test("uses stock Interchange routes only and posts caller-supplied deploy input unchanged", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const deploy = {
      source: {
        kind: "asset" as const,
        assetId: "ast_myra",
        package: { format: "source" as const, commitSha: "abc123" },
      },
      entry: "./src/index.ts",
      sourceOfferingIds: ["offering_1"],
      defaultSourceOfferingId: "offering_1",
    };
    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(init === undefined ? { path } : { path, init });
      if (path === "/api/me/principals") {
        return Promise.resolve(json({ data: [], nextCursor: null }));
      }
      if (path === "/api/tenants/tnt_primary") {
        return Promise.resolve(json(primary));
      }
      if (path === "/api/tenants/tnt_primary/principals?limit=100") {
        return Promise.resolve(json({ data: [], nextCursor: null }));
      }
      if (path === "/api/tenants" && init?.method === "POST") {
        return Promise.resolve(
          json({ ...primary, id: "tnt_child", parentId: "tnt_primary" }, 201),
        );
      }
      if (path === "/api/tenants/tnt_primary/members/invite") {
        return Promise.resolve(json({}, 201));
      }
      if (path === "/api/tenants/tnt_primary/workflows/deployments") {
        return Promise.resolve(json({ id: "dep_1" }, 201));
      }
      throw new Error(`unexpected route ${path}`);
    };
    const hub = createFetchStockHub(fetchImpl as typeof fetch);

    await hub.listMyPrincipals();
    await hub.getTenant("tnt_primary");
    await hub.listPrincipals("tnt_primary");
    await hub.createTenant({
      name: "Chat",
      slug: "chat",
      parentId: "tnt_primary",
    });
    await hub.inviteMember("tnt_primary", { email: "bea@example.com" });
    await hub.deployWorkflow("tnt_primary", deploy);

    expect(calls.map((call) => call.path)).toEqual([
      "/api/me/principals",
      "/api/tenants/tnt_primary",
      "/api/tenants/tnt_primary/principals?limit=100",
      "/api/tenants",
      "/api/tenants/tnt_primary/members/invite",
      "/api/tenants/tnt_primary/workflows/deployments",
    ]);
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual(deploy);
    expect(
      calls.some((call) =>
        /onboarding|workbench-tenancies|chat\//.test(call.path),
      ),
    ).toBe(false);
  });
});
