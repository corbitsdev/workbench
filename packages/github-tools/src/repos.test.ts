import { expect, test } from "bun:test";

import { fetchAuthenticatedLogin, listRepos } from "./repos";

const BASE = "https://github.test/api";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function fakeFetch(handler: (url: string) => Promise<Response>): typeof fetch {
  return ((input: URL | string) =>
    handler(String(input))) as unknown as typeof fetch;
}

test("listRepos reads the whole picker from one list call, never a per-repo search", async () => {
  const requested: string[] = [];
  const fetchImpl = fakeFetch((url) => {
    requested.push(url);
    if (url.includes("/user/repos")) {
      return Promise.resolve(
        jsonResponse([
          {
            id: 1,
            full_name: "acme/widgets",
            pushed_at: "2026-08-29T12:00:00Z",
          },
          { id: 2, full_name: "acme/gadgets", pushed_at: null },
        ]),
      );
    }
    throw new Error(`unstubbed request: ${url}`);
  });

  const repos = await listRepos({ apiKey: "tok", baseUrl: BASE, fetchImpl });

  expect(repos).toEqual([
    {
      id: "1",
      name: "acme/widgets",
      lastPushedAt: "2026-08-29T12:00:00Z",
    },
    { id: "2", name: "acme/gadgets" },
  ]);
  expect(requested).toHaveLength(1);
  expect(requested.some((url) => url.includes("/search/"))).toBe(false);
});

test("listRepos throws when the repos response doesn't match the expected shape", async () => {
  const fetchImpl = fakeFetch(() =>
    Promise.resolve(jsonResponse([{ id: "not-a-number" }])),
  );
  await expect(listRepos({ baseUrl: BASE, fetchImpl })).rejects.toThrow(
    /did not match the expected shape/,
  );
});

test("listRepos names the status when GitHub rejects the list call", async () => {
  const fetchImpl = fakeFetch(() =>
    Promise.resolve(
      new Response("nope", { status: 403, statusText: "Forbidden" }),
    ),
  );
  await expect(listRepos({ baseUrl: BASE, fetchImpl })).rejects.toThrow(
    /403 Forbidden/,
  );
});

test("fetchAuthenticatedLogin reads the PAT's own login", async () => {
  const fetchImpl = fakeFetch((url) => {
    expect(url).toContain("/user");
    return Promise.resolve(jsonResponse({ login: "octocat" }));
  });
  expect(await fetchAuthenticatedLogin({ baseUrl: BASE, fetchImpl })).toBe(
    "octocat",
  );
});
