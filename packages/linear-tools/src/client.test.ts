import { expect, test } from "bun:test";

import { listRecentLinearIssues } from "./client";

const NODE = {
  id: "issue_1",
  identifier: "CL-1",
  title: "Fix the thing",
  url: "https://linear.app/abklabs/issue/CL-1",
  updatedAt: "2026-08-12T09:00:00.000Z",
  state: { name: "In Progress" },
};

test("returns the parsed issues on a successful call", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: { issues: { nodes: [NODE] } } }), {
      status: 200,
    })) as unknown as typeof fetch;

  const issues = await listRecentLinearIssues({
    apiKey: "test-key",
    fetchImpl,
  });
  expect(issues).toEqual([
    {
      id: "issue_1",
      identifier: "CL-1",
      title: "Fix the thing",
      url: "https://linear.app/abklabs/issue/CL-1",
      updatedAt: "2026-08-12T09:00:00.000Z",
      state: "In Progress",
    },
  ]);
});

test("posts the api key as the authorization header", async () => {
  const captured: { auth: string | null } = { auth: null };
  const fetchImpl = (async (_input: URL | string, init?: RequestInit) => {
    captured.auth =
      (init?.headers as Record<string, string> | undefined)?.[
        "authorization"
      ] ?? null;
    return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  await listRecentLinearIssues({ apiKey: "secret", fetchImpl });
  expect(captured.auth).toBe("secret");
});

test("throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 401 })) as unknown as typeof fetch;

  await expect(
    listRecentLinearIssues({ apiKey: "bad", fetchImpl }),
  ).rejects.toThrow(/401/);
});

test("throws on a GraphQL error envelope", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ errors: [{ message: "not authenticated" }] }),
      { status: 200 },
    )) as unknown as typeof fetch;

  await expect(
    listRecentLinearIssues({ apiKey: "bad", fetchImpl }),
  ).rejects.toThrow(/GraphQL errors/);
});

test("throws when a node does not match the expected issue shape", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ data: { issues: { nodes: [{ id: "issue_1" }] } } }),
      { status: 200 },
    )) as unknown as typeof fetch;

  await expect(
    listRecentLinearIssues({ apiKey: "test-key", fetchImpl }),
  ).rejects.toThrow(/did not match the expected shape/);
});
