// Each of the four tool connector probes against a fake `FetchLike`: no
// real network calls, no real keys — a 401 must reject, a 2xx must
// accept, matching `@workbench/hub-client/credential-test`'s own
// contract for `testProviderCredential`.
import { describe, expect, test } from "bun:test";
import type { FetchLike } from "@workbench/hub-client/credential-test";
import {
  testExaCredential,
  testGitHubCredential,
  testGranolaCredential,
  testLinearCredential,
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
