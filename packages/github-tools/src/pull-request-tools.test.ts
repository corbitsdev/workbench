import { expect, test } from "bun:test";
import type { CredentialCapability, MediatedCredential } from "@intx/types";
import type { ToolCall } from "@intx/types/runtime";

import {
  GITHUB_POST_PULL_REQUEST_REVIEW_TOOL,
  GITHUB_PULL_REQUEST_DIFF_TOOL,
  githubPullRequestTools,
  type GitHubPullRequestEnv,
} from "./pull-request-tools";

const PULL_URL = "https://github.com/acme/widgets/pull/7";

/** Requests the mediated fetch saw, so a test can assert the real call. */
const requests: { url: string; method: string; body?: string }[] = [];

function respond(url: string): Response {
  if (url.includes("/pulls/7/files")) {
    return new Response(
      JSON.stringify([
        {
          filename: "src/loop.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -1,1 +1,2 @@\n context\n+added",
        },
      ]),
      { status: 200 },
    );
  }
  if (url.includes("/reviews")) {
    return new Response(
      JSON.stringify({ id: 5, html_url: `${PULL_URL}#review` }),
      { status: 200 },
    );
  }
  return new Response(
    JSON.stringify({
      title: "Add the review loop",
      body: null,
      user: { login: "octocat" },
      head: { sha: "headsha" },
      base: { sha: "basesha" },
      html_url: PULL_URL,
    }),
    { status: 200 },
  );
}

function fakeCredentials(bound: boolean): CredentialCapability {
  return {
    resolve(handle: string): Promise<MediatedCredential> {
      if (!bound) {
        return Promise.reject(
          new Error(`no credential is bound to handle "${handle}"`),
        );
      }
      return Promise.resolve({
        kind: "http",
        fetch: (input, init) => {
          const url = String(input);
          requests.push({
            url,
            method: init?.method ?? "GET",
            ...(typeof init?.body === "string" ? { body: init.body } : {}),
          });
          return Promise.resolve(respond(url));
        },
        dispose: () => {},
      });
    },
  };
}

function bundle(bound: boolean) {
  const env = {
    credentials: fakeCredentials(bound),
  } as unknown as GitHubPullRequestEnv;
  return githubPullRequestTools(env);
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

test("the bundle exposes the diff read and the review post", () => {
  expect(githubPullRequestTools.definitions.map((one) => one.name)).toEqual([
    GITHUB_PULL_REQUEST_DIFF_TOOL,
    GITHUB_POST_PULL_REQUEST_REVIEW_TOOL,
  ]);
});

test("reading a diff returns anchorable lines for each file", async () => {
  requests.length = 0;
  const result = await bundle(true).run(
    call(GITHUB_PULL_REQUEST_DIFF_TOOL, { pullRequestUrl: PULL_URL }),
    new AbortController().signal,
  );
  expect(result.isError).toBeUndefined();
  const diff = JSON.parse(String(result.content)) as {
    headSha: string;
    files: { changedLines: number[] }[];
  };
  expect(diff.headSha).toBe("headsha");
  expect(diff.files[0]?.changedLines).toEqual([1, 2]);
});

test("posting a review sends one comment-only review", async () => {
  requests.length = 0;
  const result = await bundle(true).run(
    call(GITHUB_POST_PULL_REQUEST_REVIEW_TOOL, {
      pullRequestUrl: PULL_URL,
      headSha: "headsha",
      body: "## Code review\n\nNo findings.",
      comments: [{ path: "src/loop.ts", line: 2, body: "Here." }],
    }),
    new AbortController().signal,
  );
  expect(result.isError).toBeUndefined();
  const posted = requests.find((one) => one.url.includes("/reviews"));
  expect(posted?.method).toBe("POST");
  expect(JSON.parse(String(posted?.body)) as unknown).toMatchObject({
    event: "COMMENT",
    commit_id: "headsha",
  });
});

test("an unbound credential is reported as not connected, not as a crash", async () => {
  const result = await bundle(false).run(
    call(GITHUB_PULL_REQUEST_DIFF_TOOL, { pullRequestUrl: PULL_URL }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("not connected");
});

test("a URL that is not a pull request comes back as a tool error", async () => {
  const result = await bundle(true).run(
    call(GITHUB_PULL_REQUEST_DIFF_TOOL, {
      pullRequestUrl: "https://github.com/acme/widgets",
    }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("not a GitHub pull-request URL");
});

test("a review with no body is refused before any request goes out", async () => {
  requests.length = 0;
  const result = await bundle(true).run(
    call(GITHUB_POST_PULL_REQUEST_REVIEW_TOOL, {
      pullRequestUrl: PULL_URL,
      headSha: "headsha",
      body: "",
    }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(requests.length).toBe(0);
});
