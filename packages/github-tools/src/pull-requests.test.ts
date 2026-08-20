import { expect, test } from "bun:test";

import {
  changedLinesOf,
  fetchPullRequestDiff,
  parsePullRequestUrl,
  postPullRequestReview,
} from "./pull-requests";

const BASE = "https://github.test/api";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** A stand-in for `fetch`, narrowed to what these tests exercise. */
function fakeFetch(
  handler: (input: URL | string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return handler as unknown as typeof fetch;
}

const PULL_BODY = {
  title: "Add the review loop",
  body: "Closes the loop.",
  head: { sha: "headsha" },
  base: { sha: "basesha" },
  html_url: "https://github.com/acme/widgets/pull/7",
};

const PATCH = [
  "@@ -1,3 +1,4 @@",
  " context",
  "-removed",
  "+added",
  "+also added",
].join("\n");

test("parsePullRequestUrl reads owner, repo, and number", () => {
  expect(
    parsePullRequestUrl("https://github.com/acme/widgets/pull/42"),
  ).toEqual({ owner: "acme", repo: "widgets", number: 42 });
});

test("parsePullRequestUrl rejects a URL that is not a pull request", () => {
  expect(() => parsePullRequestUrl("https://github.com/acme/widgets")).toThrow(
    /not a GitHub pull-request URL/,
  );
});

test("changedLinesOf reports the right-hand lines a hunk touches", () => {
  expect(changedLinesOf(PATCH)).toEqual([1, 2, 3]);
});

test("changedLinesOf ignores content outside any hunk", () => {
  expect(changedLinesOf("no hunk header here\n+added")).toEqual([]);
});

test("fetchPullRequestDiff returns metadata plus anchorable lines", async () => {
  const requested: string[] = [];
  const diff = await fetchPullRequestDiff(
    {
      apiKey: "token",
      baseUrl: BASE,
      fetchImpl: fakeFetch((input) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("/files")) {
          return Promise.resolve(
            jsonResponse([
              {
                filename: "src/loop.ts",
                status: "modified",
                additions: 2,
                deletions: 1,
                patch: PATCH,
              },
            ]),
          );
        }
        return Promise.resolve(jsonResponse(PULL_BODY));
      }),
    },
    { owner: "acme", repo: "widgets", number: 7 },
  );

  expect(diff.title).toBe("Add the review loop");
  expect(diff.headSha).toBe("headsha");
  expect(diff.files[0]?.changedLines).toEqual([1, 2, 3]);
  expect(requested.some((url) => url.includes("/pulls/7/files"))).toBe(true);
});

test("fetchPullRequestDiff sends a bearer header only when given a token", async () => {
  const sent: (Record<string, string> | undefined)[] = [];
  await fetchPullRequestDiff(
    {
      baseUrl: BASE,
      fetchImpl: fakeFetch((input, init) => {
        sent.push(init?.headers as Record<string, string> | undefined);
        return Promise.resolve(
          String(input).includes("/files")
            ? jsonResponse([])
            : jsonResponse(PULL_BODY),
        );
      }),
    },
    { owner: "acme", repo: "widgets", number: 7 },
  );
  for (const headers of sent) {
    expect(headers?.authorization).toBeUndefined();
  }
});

test("fetchPullRequestDiff names a response whose shape is wrong", async () => {
  await expect(
    fetchPullRequestDiff(
      {
        apiKey: "token",
        baseUrl: BASE,
        fetchImpl: fakeFetch((input) =>
          Promise.resolve(
            String(input).includes("/files")
              ? jsonResponse([])
              : jsonResponse({ title: "no head sha" }),
          ),
        ),
      },
      { owner: "acme", repo: "widgets", number: 7 },
    ),
  ).rejects.toThrow(/did not match the expected shape/);
});

test("postPullRequestReview posts one comment-only review at the head sha", async () => {
  let sent: { url: string; body: unknown } | undefined;
  const posted = await postPullRequestReview(
    {
      apiKey: "token",
      baseUrl: BASE,
      fetchImpl: fakeFetch((input, init) => {
        sent = {
          url: String(input),
          body: JSON.parse(String(init?.body)) as unknown,
        };
        return Promise.resolve(
          jsonResponse({
            id: 99,
            html_url: "https://github.com/acme/widgets/pull/7#review",
          }),
        );
      }),
    },
    { owner: "acme", repo: "widgets", number: 7 },
    "headsha",
    {
      body: "One review.",
      comments: [{ path: "src/loop.ts", line: 2, body: "This breaks." }],
    },
  );

  expect(posted).toEqual({
    id: 99,
    url: "https://github.com/acme/widgets/pull/7#review",
  });
  expect(sent?.url).toBe(`${BASE}/repos/acme/widgets/pulls/7/reviews`);
  expect(sent?.body).toEqual({
    commit_id: "headsha",
    body: "One review.",
    event: "COMMENT",
    comments: [
      { path: "src/loop.ts", line: 2, side: "RIGHT", body: "This breaks." },
    ],
  });
});

test("postPullRequestReview refuses an empty body", async () => {
  await expect(
    postPullRequestReview(
      { apiKey: "token", baseUrl: BASE },
      { owner: "acme", repo: "widgets", number: 7 },
      "headsha",
      { body: "   ", comments: [] },
    ),
  ).rejects.toThrow(/non-empty body/);
});
