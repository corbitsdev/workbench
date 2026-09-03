import { describe, expect, test } from "bun:test";

import {
  createWorkflowConnectionRoutes,
  type WorkflowConnectionRunScope,
} from "./workflow-connection-routes";
import type { ConnectorRegistry } from "./registry";

/** A fixture standing in for the real connector set a build's own
 * `templates/connectors.ts` carries — this package holds no concrete
 * connector set of its own (CL-7384). */
const TEST_REGISTRY: ConnectorRegistry = {
  github: {
    id: "github",
    displayName: "GitHub",
    authKind: "api-key",
    credentialPlugin: "http",
    docsUrl: "https://github.com/settings/tokens",
    feedsTools: ["@corbits/github-tools"],
  },
  linear: {
    id: "linear",
    displayName: "Linear",
    authKind: "api-key",
    credentialPlugin: "http-raw-authorization",
    docsUrl: "https://linear.app/settings/api",
    feedsTools: ["@corbits/linear-tools"],
  },
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    authKind: "api-key",
    credentialPlugin: "http",
    docsUrl: "https://console.anthropic.com/settings/keys",
    feedsTools: [],
  },
};

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
      registry: TEST_REGISTRY,
      isConnectorConnected: async () => false,
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

  test("reports a non-inference connector (GitHub) connected once it has a real, verified credential", async () => {
    // CL-6492: `list_connections` used to resolve every connector's
    // status from the inference-only model catalog, so a verified
    // GitHub PAT (never seeded into that catalog) always read "not
    // connected" — the agent would refuse work it could actually do.
    let seenTenantId: string | undefined;
    let seenConnectorId: string | undefined;
    const app = createWorkflowConnectionRoutes({
      authenticator: fakeAuthenticator(),
      registry: TEST_REGISTRY,
      isConnectorConnected: async (tenantId, connectorId) => {
        if (connectorId === "github") {
          seenTenantId = tenantId;
          seenConnectorId = connectorId;
          return true;
        }
        return false;
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
    expect(seenConnectorId).toBe("github");
    const body = (await response.json()) as {
      data: { id: string; displayName: string; connected: boolean }[];
    };
    const github = body.data.find((entry) => entry.id === "github");
    expect(github?.connected).toBe(true);
  });

  test("still reports an unconnected connector as not connected", async () => {
    const app = createWorkflowConnectionRoutes({
      authenticator: fakeAuthenticator(),
      registry: TEST_REGISTRY,
      isConnectorConnected: async () => false,
    });

    const response = await app.request("/connections", {
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "x-workflow-run-address": VALID_ADDRESS,
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { id: string; displayName: string; connected: boolean }[];
    };
    const linear = body.data.find((entry) => entry.id === "linear");
    expect(linear?.connected).toBe(false);
    // The full registry, not a filtered subset — an unconnected
    // connector still gets a card the client can render a "not
    // connected" state for.
    expect(body.data.length).toBeGreaterThan(2);
  });

  test("keeps reporting an inference provider (Anthropic) connected", async () => {
    const app = createWorkflowConnectionRoutes({
      authenticator: fakeAuthenticator(),
      registry: TEST_REGISTRY,
      isConnectorConnected: async (_tenantId, connectorId) =>
        connectorId === "anthropic",
    });

    const response = await app.request("/connections", {
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "x-workflow-run-address": VALID_ADDRESS,
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { id: string; displayName: string; connected: boolean }[];
    };
    const anthropic = body.data.find((entry) => entry.id === "anthropic");
    expect(anthropic?.connected).toBe(true);
  });

  test("never calls isConnectorConnected before authentication succeeds", async () => {
    let called = false;
    const app = createWorkflowConnectionRoutes({
      authenticator: fakeAuthenticator(),
      registry: TEST_REGISTRY,
      isConnectorConnected: async () => {
        called = true;
        return false;
      },
    });

    await app.request("/connections", {
      headers: { authorization: "Bearer nope", "x-workflow-run-address": "x" },
    });

    expect(called).toBe(false);
  });
});
