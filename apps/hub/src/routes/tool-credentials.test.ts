import { describe, expect, test } from "bun:test";
import type { resolveCredentialRequirement } from "@intx/db";
import { createToolCredentialsRouter } from "./tool-credentials";

// 'exa'/'firecrawl' resolve to a secret; 'github' resolves to null (no
// credential configured). The allowed providers derive from the agent's pinned
// tool packages (@workbench/tools-exa→exa, -firecrawl→firecrawl, -github→github).
const fakeResolve = (async (
  _db: unknown,
  _tenantId: string,
  req: { providerName: string },
) => {
  if (req.providerName === "github") return null;
  return {
    secret: `secret-${req.providerName}`,
    providerId: `prov-${req.providerName}`,
  };
}) as unknown as typeof resolveCredentialRequirement;

const agentToolPackages = [
  { name: "@workbench/tools-exa", version: "^0.1.0" },
  { name: "@workbench/tools-firecrawl", version: "^0.1.0" },
  { name: "@workbench/tools-github", version: "^0.1.0" },
];

const emptyMemberPrincipalDbStubs = {
  agentInstance: {
    findFirst: async () => undefined,
  },
  principal: {
    findFirst: async () => undefined,
  },
  workflowRunRecord: {
    findFirst: async () => undefined,
  },
};

const fakeDb = {
  query: {
    agent: {
      findFirst: async () => ({ id: "a1", toolPackages: agentToolPackages }),
    },
    provider: {
      findFirst: async () => ({ metadata: { baseURL: "https://api.example" } }),
    },
    ...emptyMemberPrincipalDbStubs,
  },
} as unknown as Parameters<typeof createToolCredentialsRouter>[0];

const router = createToolCredentialsRouter(
  fakeDb,
  "sidecar-token",
  fakeResolve,
);

async function post(body: unknown, token = "sidecar-token"): Promise<Response> {
  return await router.request("/tools/credentials", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

const req = (providerNames: string[]) => ({
  tenantId: "t1",
  agentId: "a1",
  providerNames,
});

describe("POST /tools/credentials", () => {
  test("rejects an unauthorized caller", async () => {
    expect((await post(req(["exa"]), "wrong")).status).toBe(401);
  });

  test("resolves providers the agent is allowed to use", async () => {
    const res = await post(req(["exa", "firecrawl"]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Record<string, unknown> };
    expect(body.credentials).toEqual({
      exa: { apiKey: "secret-exa", baseURL: "https://api.example" },
      firecrawl: { apiKey: "secret-firecrawl", baseURL: "https://api.example" },
    });
  });

  test("rejects a provider the agent is not allowed to request (403)", async () => {
    // youtube_search is not in the agent's capabilities, so youtube is forbidden.
    expect((await post(req(["youtube"]))).status).toBe(403);
  });

  test("omits an allowed provider that has no configured credential (no error)", async () => {
    const res = await post(req(["github"]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Record<string, unknown> };
    expect(body.credentials).toEqual({});
  });

  test("degrades per-provider: returns the configured ones and skips the unconfigured", async () => {
    const res = await post(req(["exa", "github", "firecrawl"]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Record<string, unknown> };
    expect(body.credentials).toEqual({
      exa: { apiKey: "secret-exa", baseURL: "https://api.example" },
      firecrawl: { apiKey: "secret-firecrawl", baseURL: "https://api.example" },
    });
    expect("github" in body.credentials).toBe(false);
  });

  test("returns 400 on a malformed request body", async () => {
    expect((await post({ tenantId: "t1", agentId: "a1" })).status).toBe(400);
  });
});

describe("POST /tools/credentials member principal", () => {
  const fakeMemberResolve = async (
    _db: unknown,
    _tenantId: string,
    memberPrincipalId: string,
    providerName: string,
  ) => {
    if (memberPrincipalId === "prn-user" && providerName === "exa") {
      return {
        apiKey: "member-exa-secret",
        baseURL: "https://api.example",
        source: "member" as const,
      };
    }
    return null;
  };

  const memberDb = {
    query: {
      agent: {
        findFirst: async () => ({ id: "a1", toolPackages: agentToolPackages }),
      },
      provider: {
        findFirst: async () => ({ metadata: { baseURL: "https://api.example" } }),
      },
      principal: {
        findFirst: async () => ({ id: "prn-user" }),
      },
      agentInstance: {
        findFirst: async () => undefined,
      },
      workflowRunRecord: {
        findFirst: async () => undefined,
      },
    },
  } as unknown as Parameters<typeof createToolCredentialsRouter>[0];

  const memberRouter = createToolCredentialsRouter(
    memberDb,
    "sidecar-token",
    fakeResolve,
    fakeMemberResolve,
  );

  test("uses member-or-tenant resolution when memberPrincipalId is validated", async () => {
    const res = await memberRouter.request("/tools/credentials", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sidecar-token",
      },
      body: JSON.stringify({
        tenantId: "t1",
        agentId: "a1",
        providerNames: ["exa"],
        memberPrincipalId: "prn-user",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Record<string, unknown> };
    expect(body.credentials).toEqual({
      exa: { apiKey: "member-exa-secret", baseURL: "https://api.example" },
    });
  });

  test("uses run creator principal when workflowRunId matches step deployment", async () => {
    const runMemberResolve = async (
      _db: unknown,
      _tenantId: string,
      memberPrincipalId: string,
      providerName: string,
    ) => {
      if (memberPrincipalId === "prn-run-creator" && providerName === "exa") {
        return {
          apiKey: "run-member-exa",
          baseURL: "https://api.example",
          source: "member" as const,
        };
      }
      return null;
    };

    const runDb = {
      query: {
        agent: {
          findFirst: async () => ({ id: "a1", toolPackages: agentToolPackages }),
        },
        provider: {
          findFirst: async () => ({
            metadata: { baseURL: "https://api.example" },
          }),
        },
        workflowRunRecord: {
          findFirst: async () => ({
            principalId: "prn-run-creator",
            deploymentId: "ses_dep-1",
          }),
        },
        agentInstance: {
          findFirst: async () => undefined,
        },
        principal: {
          findFirst: async () => undefined,
        },
      },
    } as unknown as Parameters<typeof createToolCredentialsRouter>[0];

    const runRouter = createToolCredentialsRouter(
      runDb,
      "sidecar-token",
      fakeResolve,
      runMemberResolve,
    );

    const res = await runRouter.request("/tools/credentials", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sidecar-token",
      },
      body: JSON.stringify({
        tenantId: "t1",
        agentId: "ins_ses_dep-1-heartbeat-intake-linear",
        providerNames: ["exa"],
        workflowRunId: "run-1",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Record<string, unknown> };
    expect(body.credentials).toEqual({
      exa: { apiKey: "run-member-exa", baseURL: "https://api.example" },
    });
  });
});

describe("POST /tools/credentials provider gating from pinned packages", () => {
  // A workflow step is provisioned as a real agent row carrying its step pins,
  // so it is gated identically: reddit's package authorizes the scrapecreators
  // provider it shares.
  const pinnedDb = {
    query: {
      agent: {
        findFirst: async () => ({
          id: "a1",
          toolPackages: [
            { name: "@workbench/tools-reddit", version: "^0.1.0" },
          ],
        }),
      },
      provider: {
        findFirst: async () => ({
          metadata: { baseURL: "https://api.example" },
        }),
      },
      ...emptyMemberPrincipalDbStubs,
    },
  } as unknown as Parameters<typeof createToolCredentialsRouter>[0];

  const pinnedRouter = createToolCredentialsRouter(
    pinnedDb,
    "sidecar-token",
    fakeResolve,
  );

  const post = (providerNames: string[]) =>
    pinnedRouter.request("/tools/credentials", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sidecar-token",
      },
      body: JSON.stringify(req(providerNames)),
    });

  test("authorizes the provider the pinned package declares", async () => {
    expect((await post(["scrapecreators"])).status).toBe(200);
  });

  test("rejects a provider no pinned package declares (403)", async () => {
    expect((await post(["exa"])).status).toBe(403);
  });
});
