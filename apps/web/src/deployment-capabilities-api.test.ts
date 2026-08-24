import { afterEach, describe, expect, test } from "bun:test";

import {
  fetchDeploymentCapabilities,
  slackTriggerOffered,
} from "./deployment-capabilities-api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(
  respond: (path: string) => Response | Promise<Response>,
): void {
  globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    return Promise.resolve(respond(path));
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("fetchDeploymentCapabilities", () => {
  test("a genuine slackConfigured:false is ready, not unavailable", async () => {
    stubFetch(() => json({ slackConfigured: false }));
    const result = await fetchDeploymentCapabilities();
    expect(result).toEqual({ kind: "ready", slackConfigured: false });
  });

  test("a configured deployment is ready with slackConfigured:true", async () => {
    stubFetch(() => json({ slackConfigured: true }));
    const result = await fetchDeploymentCapabilities();
    expect(result).toEqual({ kind: "ready", slackConfigured: true });
  });

  test("a non-2xx response is unavailable, not slackConfigured:false", async () => {
    stubFetch(() => json({ message: "boom" }, 500));
    const result = await fetchDeploymentCapabilities();
    expect(result.kind).toBe("unavailable");
  });

  test("a body that fails the schema is unavailable", async () => {
    stubFetch(() => json({ slackConfigured: "yes" }));
    const result = await fetchDeploymentCapabilities();
    expect(result.kind).toBe("unavailable");
  });

  test("a network failure is unavailable", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.reject(new Error("network down"))) as typeof fetch;
    const result = await fetchDeploymentCapabilities();
    expect(result).toEqual({
      kind: "unavailable",
      message: "network down",
    });
  });
});

describe("slackTriggerOffered", () => {
  test("hides Slack while the probe is still loading", () => {
    expect(slackTriggerOffered(null)).toBe(false);
  });

  test("follows the hub when the probe answered", () => {
    expect(
      slackTriggerOffered({ kind: "ready", slackConfigured: false }),
    ).toBe(false);
    expect(
      slackTriggerOffered({ kind: "ready", slackConfigured: true }),
    ).toBe(true);
  });

  test("keeps Slack offered when the probe failed — never hides solely on failure", () => {
    expect(
      slackTriggerOffered({
        kind: "unavailable",
        message: "The server answered 500 for deployment capabilities.",
      }),
    ).toBe(true);
  });
});
