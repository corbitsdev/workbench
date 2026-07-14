import { afterEach, describe, expect, test } from "bun:test";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import { fetchToolCredentials } from "./default-harness";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const baseArgs = {
  hubHttpUrl: "https://hub.test",
  sidecarToken: "tok",
  tenantId: "t1",
  agentId: "a1",
  agentAddress: "a1@hub",
};

describe("fetchToolCredentials", () => {
  test("returns no entries when no providers are required", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const env = await fetchToolCredentials({ ...baseArgs, providerNames: [] });
    expect(env).toEqual({});
    expect(called).toBe(false);
  });

  test("threads workflowRunId and memberPrincipalId in the request body", async () => {
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const parsed = JSON.parse(String(init?.body)) as {
        workflowRunId?: string;
        memberPrincipalId?: string;
      };
      expect(parsed.workflowRunId).toBe("run-42");
      expect(parsed.memberPrincipalId).toBe("prn-live");
      return new Response(
        JSON.stringify({ credentials: {} }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await fetchToolCredentials({
      ...baseArgs,
      providerNames: ["exa"],
      workflowRunId: "run-42",
      memberPrincipalId: "prn-live",
    });
  });

  test("maps resolved credentials onto provider-namespaced env keys", async () => {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer tok" });
      expect(String(input)).toContain("/api/internal/tools/credentials");
      return new Response(
        JSON.stringify({
          credentials: { exa: { apiKey: "k-exa", baseURL: "https://api.exa" } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const env = await fetchToolCredentials({
      ...baseArgs,
      providerNames: ["exa"],
    });
    expect(env[toolCredentialEnvKey("exa")]).toEqual({
      apiKey: "k-exa",
      baseURL: "https://api.exa",
    });
  });

  test("fails soft (empty) on a non-ok response", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 422 })) as unknown as typeof fetch;
    const env = await fetchToolCredentials({
      ...baseArgs,
      providerNames: ["exa"],
    });
    expect(env).toEqual({});
  });

  test("fails soft (empty) when the response fails schema validation", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ credentials: { exa: { apiKey: 1 } } }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const env = await fetchToolCredentials({
      ...baseArgs,
      providerNames: ["exa"],
    });
    expect(env).toEqual({});
  });
});
