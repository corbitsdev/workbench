import { expect, test } from "bun:test";

import {
  AccessForbiddenError,
  AccessNotFoundError,
  grantAccess,
  revokeAccess,
  type AccessToolClientConfig,
} from "./client";

function testConfig(fetchImpl: typeof fetch): AccessToolClientConfig {
  return {
    hubAccessUrl: "https://hub.example.com/api/workflow-access",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };
}

test("a 403 from grantAccess surfaces as AccessForbiddenError with the hub's userMessage", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "forbidden",
          userMessage: "You do not have permission to perform this action",
        },
      }),
      { status: 403 },
    )) as unknown as typeof fetch;

  await expect(
    grantAccess(testConfig(fetchImpl), {
      principalId: "prin_2",
      resource: "workflow-run:*",
      actions: ["read"],
    }),
  ).rejects.toThrow(AccessForbiddenError);
});

test("a 404 from revokeAccess surfaces as AccessNotFoundError", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "not_found", userMessage: "No grant here" },
      }),
      { status: 404 },
    )) as unknown as typeof fetch;

  await expect(
    revokeAccess(testConfig(fetchImpl), "grant_missing"),
  ).rejects.toThrow(AccessNotFoundError);
});
