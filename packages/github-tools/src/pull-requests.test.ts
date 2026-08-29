import { expect, test } from "bun:test";

import {
  changedLinesOf,
  fetchPullRequestDiff,
  fetchPullRequestReviewComments,
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
  user: { login: "octocat" },
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
  expect(diff.author).toBe("octocat");
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

test("fetchPullRequestReviewComments returns each comment's body", async () => {
  const page = await fetchPullRequestReviewComments(
    {
      apiKey: "token",
      baseUrl: BASE,
      fetchImpl: fakeFetch(() =>
        Promise.resolve(jsonResponse([{ body: "first" }, { body: "second" }])),
      ),
    },
    { owner: "acme", repo: "widgets", number: 7 },
  );
  expect(page).toEqual({ comments: ["first", "second"], truncated: false });
});

/** A page short enough to end pagination whichever way the caller detects it. */
function shortPage(bodies: string[], link?: string): Response {
  return new Response(JSON.stringify(bodies.map((body) => ({ body }))), {
    status: 200,
    headers: link === undefined ? {} : { link },
  });
}

/** A full (100-item) page, to drive the page-number fallback when no `Link` header is sent. */
function fullPage(prefix: string): Response {
  const bodies = Array.from({ length: 100 }, (_, i) => ({
    body: `${prefix}-${String(i)}`,
  }));
  return new Response(JSON.stringify(bodies), { status: 200 });
}

test('fetchPullRequestReviewComments follows a Link: rel="next" header across pages', async () => {
  const requestedUrls: string[] = [];
  const page = await fetchPullRequestReviewComments(
    {
      apiKey: "token",
      baseUrl: BASE,
      fetchImpl: fakeFetch((input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes("page=2")) {
          return Promise.resolve(shortPage(["third", "fourth"]));
        }
        return Promise.resolve(
          shortPage(["first", "second"], `<${BASE}/next?page=2>; rel="next"`),
        );
      }),
    },
    { owner: "acme", repo: "widgets", number: 7 },
  );
  expect(page).toEqual({
    comments: ["first", "second", "third", "fourth"],
    truncated: false,
  });
  expect(requestedUrls).toHaveLength(2);
});

test("fetchPullRequestReviewComments falls back to page= when no Link header is sent", async () => {
  let calls = 0;
  const page = await fetchPullRequestReviewComments(
    {
      apiKey: "token",
      baseUrl: BASE,
      fetchImpl: fakeFetch(() => {
        calls += 1;
        return Promise.resolve(
          calls === 1 ? fullPage("p1") : shortPage(["last"]),
        );
      }),
    },
    { owner: "acme", repo: "widgets", number: 7 },
  );
  expect(page.comments).toHaveLength(101);
  expect(page.comments[100]).toBe("last");
  expect(page.truncated).toBe(false);
  expect(calls).toBe(2);
});

test("fetchPullRequestReviewComments reports truncated when the page bound is hit", async () => {
  const page = await fetchPullRequestReviewComments(
    {
      apiKey: "token",
      baseUrl: BASE,
      fetchImpl: fakeFetch(() => Promise.resolve(fullPage("p"))),
    },
    { owner: "acme", repo: "widgets", number: 7 },
  );
  expect(page.truncated).toBe(true);
  expect(page.comments).toHaveLength(3000);
});

test("fetchPullRequestDiff follows pagination for files and reports it unset for one page", async () => {
  const diff = await fetchPullRequestDiff(
    {
      apiKey: "token",
      baseUrl: BASE,
      fetchImpl: fakeFetch((input) => {
        const url = String(input);
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
  expect(diff.truncated).toBe(false);
  expect(diff.files).toHaveLength(1);
});

function fileAt(index: number): Record<string, unknown> {
  return {
    filename: `src/file-${String(index)}.ts`,
    status: "modified",
    additions: 1,
    deletions: 0,
  };
}

test("fetchPullRequestDiff merges every page of changed files", async () => {
  const diff = await fetchPullRequestDiff(
    {
      apiKey: "token",
      baseUrl: BASE,
      fetchImpl: fakeFetch((input) => {
        const url = String(input);
        if (url.includes("page=2")) {
          return Promise.resolve(
            new Response(JSON.stringify([fileAt(100)]), { status: 200 }),
          );
        }
        if (url.includes("/files")) {
          const files = Array.from({ length: 100 }, (_, i) => fileAt(i));
          return Promise.resolve(
            new Response(JSON.stringify(files), {
              status: 200,
              headers: {
                link: `<${BASE}/repos/acme/widgets/pulls/7/files?page=2>; rel="next"`,
              },
            }),
          );
        }
        return Promise.resolve(jsonResponse(PULL_BODY));
      }),
    },
    { owner: "acme", repo: "widgets", number: 7 },
  );
  expect(diff.files).toHaveLength(101);
  expect(diff.truncated).toBe(false);
});

test("fetchPullRequestDiff reports truncated when the file-page bound is hit", async () => {
  const diff = await fetchPullRequestDiff(
    {
      apiKey: "token",
      baseUrl: BASE,
      fetchImpl: fakeFetch((input) => {
        const url = String(input);
        if (url.includes("/files")) {
          const files = Array.from({ length: 100 }, (_, i) => fileAt(i));
          return Promise.resolve(jsonResponse(files));
        }
        return Promise.resolve(jsonResponse(PULL_BODY));
      }),
    },
    { owner: "acme", repo: "widgets", number: 7 },
  );
  expect(diff.truncated).toBe(true);
  expect(diff.files).toHaveLength(3000);
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
