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
      listConnectedProviders: async () => [],
    });

    const response = await app.request("/connections", {
      headers: {
        authorization: "Bearer wrong-token",
        "x-workflow-run-address": VALID_ADDRESS,
      },
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  test("returns every registry entry with its live connected status for the authenticated tenant", async () => {
    let seenTenantId: string | undefined;
    const app = createWorkflowConnectionRoutes({
      authenticator: fakeAuthenticator(),
      listConnectedProviders: async (tenantId) => {
        seenTenantId = tenantId;
        return ["granola", "exa"];
      },
    });

    const response = await app.request("/connections", {
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "x-workflow-run-address": VALID_ADDRESS,
      },
    });

    expect(response.status).toBe(200);
    expect(seenTenantId).toBe("tenant_1");
    const body = (await response.json()) as {
      data: { id: string; displayName: string; connected: boolean }[];
    };
    const granola = body.data.find((entry) => entry.id === "granola");
    const linear = body.data.find((entry) => entry.id === "linear");
    expect(granola?.connected).toBe(true);
    expect(linear?.connected).toBe(false);
    // The full registry, not a filtered subset — an unconnected
    // connector still gets a card the client can render a "not
    // connected" state for.
    expect(body.data.length).toBeGreaterThan(2);
  });

  test("never calls listConnectedProviders before authentication succeeds", async () => {
    let called = false;
    const app = createWorkflowConnectionRoutes({
      authenticator: fakeAuthenticator(),
      listConnectedProviders: async () => {
        called = true;
        return [];
      },
    });

    await app.request("/connections", {
      headers: { authorization: "Bearer nope", "x-workflow-run-address": "x" },
    });

    expect(called).toBe(false);
  });
});
