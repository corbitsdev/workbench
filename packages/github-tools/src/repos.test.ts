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

test("listRepos maps each repo and fills in its own open-PR count", async () => {
  const requested: string[] = [];
  const fetchImpl = fakeFetch((url) => {
    requested.push(url);
    if (url.includes("/user/repos")) {
      return Promise.resolve(
        jsonResponse([
          { id: 1, full_name: "acme/widgets" },
          { id: 2, full_name: "acme/gadgets" },
        ]),
      );
    }
    if (url.includes("repo%3Aacme%2Fwidgets")) {
      return Promise.resolve(jsonResponse({ total_count: 3 }));
    }
    if (url.includes("repo%3Aacme%2Fgadgets")) {
      return Promise.resolve(jsonResponse({ total_count: 0 }));
    }
    throw new Error(`unstubbed request: ${url}`);
  });

  const repos = await listRepos({ apiKey: "tok", baseUrl: BASE, fetchImpl });

  expect(repos).toEqual([
    { id: "1", name: "acme/widgets", openPullRequestCount: 3 },
    { id: "2", name: "acme/gadgets", openPullRequestCount: 0 },
  ]);
  expect(requested.some((url) => url.includes("/user/repos"))).toBe(true);
});

test("listRepos throws when the repos response doesn't match the expected shape", async () => {
  const fetchImpl = fakeFetch(() =>
    Promise.resolve(jsonResponse([{ id: "not-a-number" }])),
  );
  await expect(listRepos({ baseUrl: BASE, fetchImpl })).rejects.toThrow(
    /did not match the expected shape/,
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
