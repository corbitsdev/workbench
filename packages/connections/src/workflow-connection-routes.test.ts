import { describe, expect, test } from "bun:test";

import {
  createWorkflowConnectionRoutes,
  type WorkflowConnectionRunScope,
} from "./workflow-connection-routes";

const VALID_TOKEN = "sc-token";
const VALID_ADDRESS = "run_1@workflow";
const SCOPE: WorkflowConnectionRunScope = {
  tenantId: "tenant_1",
  principalId: "principal_1",
  runId: "run_1",
};

function fakeAuthenticator() {
  return {
    resolve: async (token: string, address: string) =>
      token === VALID_TOKEN && address === VALID_ADDRESS ? SCOPE : null,
  };
}

describe("createWorkflowConnectionRoutes", () => {
  test("rejects a call with a missing or unrecognized sidecar bearer token / run address", async () => {
    const app = createWorkflowConnectionRoutes({
      authenticator: fakeAuthenticator(),
      listMcpServers: async () => [],
    });

    const response = await app.request("/mcp-servers", {
      headers: {
        authorization: "Bearer wrong-token",
        "x-workflow-run-address": VALID_ADDRESS,
      },
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  test("never reads the MCP registry before authentication succeeds", async () => {
    let called = false;
    const app = createWorkflowConnectionRoutes({
      authenticator: fakeAuthenticator(),
      listMcpServers: async () => {
        called = true;
        return [];
      },
    });

    await app.request("/mcp-servers", {
      headers: { authorization: "Bearer nope", "x-workflow-run-address": "x" },
    });

    expect(called).toBe(false);
  });

  test("scopes the MCP-server listing to the authenticated run's own tenant", async () => {
    let seenTenantId: string | undefined;
    const app = createWorkflowConnectionRoutes({
      authenticator: fakeAuthenticator(),
      listMcpServers: async (tenantId) => {
        seenTenantId = tenantId;
        return [
          {
            slug: "granola",
            name: "Granola",
            url: "https://mcp.granola.ai",
          } as never,
        ];
      },
    });

    const response = await app.request("/mcp-servers", {
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "x-workflow-run-address": VALID_ADDRESS,
      },
    });

    expect(response.status).toBe(200);
    expect(seenTenantId).toBe("tenant_1");
    const body = (await response.json()) as { data: { slug: string }[] };
    expect(body.data.map((row) => row.slug)).toEqual(["granola"]);
  });
});
