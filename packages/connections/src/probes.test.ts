// Each of the four tool connector probes against a fake `FetchLike`: no
// real network calls, no real keys — a 401 must reject, a 2xx must
// accept, matching `./credential-test`'s own
// contract for `testProviderCredential`.
import { describe, expect, spyOn, test } from "bun:test";
import * as errorSink from "@corbits/error-sink";
import type { FetchLike } from "./credential-test";
import {
  testExaCredential,
  testGitHubCredential,
  testGranolaCredential,
  testLinearCredential,
  testManusCredential,
  testScrapeCreatorsCredential,
} from "./probes";

function fakeFetch(status: number, body = "{}"): FetchLike {
  return async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("testGranolaCredential", () => {
  test("rejects a 401", async () => {
    const result = await testGranolaCredential("test-key", fakeFetch(401));
    expect(result.ok).toBe(false);
  });

  test("accepts a 200", async () => {
    const result = await testGranolaCredential(
      "test-key",
      fakeFetch(200, JSON.stringify({ notes: [] })),
    );
    expect(result.ok).toBe(true);
  });

  test("a transport failure is reported by displayName, never the key", async () => {
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
    const fetchImpl: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const result = await testGranolaCredential("test-key", fetchImpl);
    expect(result.ok).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "probe_credential",
      extra: { displayName: "Granola" },
    });
    report.mockRestore();
  });
});

describe("testExaCredential", () => {
  test("rejects a 401", async () => {
    const result = await testExaCredential("test-key", fakeFetch(401));
    expect(result.ok).toBe(false);
  });

  test("accepts a 200", async () => {
    const result = await testExaCredential(
      "test-key",
      fakeFetch(200, JSON.stringify({ results: [] })),
    );
    expect(result.ok).toBe(true);
  });
});

describe("testScrapeCreatorsCredential", () => {
  test("rejects a 401", async () => {
    const result = await testScrapeCreatorsCredential(
      "test-key",
      fakeFetch(401),
    );
    expect(result.ok).toBe(false);
  });

  test("accepts a 200", async () => {
    const result = await testScrapeCreatorsCredential(
      "test-key",
      fakeFetch(200, JSON.stringify({ posts: [] })),
    );
    expect(result.ok).toBe(true);
  });
});

describe("testGitHubCredential", () => {
  test("rejects a 401", async () => {
    const result = await testGitHubCredential("test-key", fakeFetch(401));
    expect(result.ok).toBe(false);
  });

  test("accepts a 200", async () => {
    const result = await testGitHubCredential(
      "test-key",
      fakeFetch(200, JSON.stringify({ login: "octocat" })),
    );
    expect(result.ok).toBe(true);
  });

  test("targets api.github.com by default (CL-6403)", async () => {
    const requested: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
      });
    };
    await testGitHubCredential("test-key", fetchImpl);
    expect(requested).toEqual(["https://api.github.com/user"]);
  });

  test("targets an override baseUrl when the caller sets one (CL-6403)", async () => {
    const requested: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
      });
    };
    const result = await testGitHubCredential(
      "test-key",
      fetchImpl,
      "http://fake-github.test",
    );
    expect(requested).toEqual(["http://fake-github.test/user"]);
    expect(result.ok).toBe(true);
  });
});

describe("testLinearCredential", () => {
  test("rejects a 401", async () => {
    const result = await testLinearCredential("test-key", fakeFetch(401));
    expect(result.ok).toBe(false);
  });

  test("accepts a 200", async () => {
    const result = await testLinearCredential(
      "test-key",
      fakeFetch(200, JSON.stringify({ data: { viewer: { id: "usr_1" } } })),
    );
    expect(result.ok).toBe(true);
  });
});

describe("testManusCredential", () => {
  test("rejects a 401", async () => {
    const result = await testManusCredential("test-key", fakeFetch(401));
    expect(result.ok).toBe(false);
  });

  test("accepts a 200", async () => {
    const result = await testManusCredential(
      "test-key",
      fakeFetch(200, JSON.stringify({ ok: true, skills: [] })),
    );
    expect(result.ok).toBe(true);
  });

  test("sends x-manus-api-key to skill.list", async () => {
    const requested: { url: string; key: string | null }[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      requested.push({
        url: String(input),
        key:
          (init?.headers as Headers | undefined)?.get("x-manus-api-key") ??
          null,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const result = await testManusCredential("manus_key", fetchImpl);
    expect(result.ok).toBe(true);
    expect(requested).toEqual([
      { url: "https://api.manus.ai/v2/skill.list", key: "manus_key" },
    ]);
  });
});
