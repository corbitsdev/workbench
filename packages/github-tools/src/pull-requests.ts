// Pull-request reads and one write, on top of the same minimal REST
// client `./client.ts` uses for search. Unlike search, both calls here
// need a real credential: the diff of a private repository is not
// readable keylessly, and posting a review is a write GitHub only
// accepts from an authenticated caller. A missing token is therefore an
// error at this boundary rather than a lower rate limit.
//
// The right-hand line numbers a patch actually touches are parsed out of
// each file's hunk headers. GitHub rejects a review comment anchored to
// a line outside the diff, so a caller that wants inline comments has to
// know which lines are anchorable before it posts — that is what
// `changedLines` is for.
import { type } from "arktype";

import type { GitHubClientConfig } from "./client";

const DEFAULT_BASE_URL = "https://api.github.com";
const MAX_FILES_PER_PAGE = 100;

const PullRequestResponse = type({
  title: "string",
  "body?": "string | null",
  head: { sha: "string" },
  base: { sha: "string" },
  html_url: "string",
});

const PullRequestFileResponse = type({
  filename: "string",
  status: "string",
  additions: "number",
  deletions: "number",
  "patch?": "string",
});

const PullRequestFilesResponse = PullRequestFileResponse.array();

const PostedReviewResponse = type({
  id: "number",
  html_url: "string",
});

/** Which pull request a call is about. */
export interface PullRequestRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface PullRequestFileDiff {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  /** Absent for files GitHub reports without a patch (binary, too large). */
  readonly patch?: string;
  /** Right-hand line numbers this patch touches; the anchorable set. */
  readonly changedLines: readonly number[];
}

export interface PullRequestDiff {
  readonly ref: PullRequestRef;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  /** The head commit a posted review is anchored to. */
  readonly headSha: string;
  readonly baseSha: string;
  readonly files: readonly PullRequestFileDiff[];
}

/** One inline comment on a posted review. */
export interface PullRequestReviewComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

/** The review a reviewer run posts: one body plus inline comments. */
export interface PullRequestReviewDraft {
  readonly body: string;
  readonly comments: readonly PullRequestReviewComment[];
}

export interface PostedPullRequestReview {
  readonly id: number;
  readonly url: string;
}

const PULL_REQUEST_URL =
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/**
 * Reads a `PullRequestRef` out of a pull-request URL. The URL arrives
 * from a webhook payload or a person's message, so a shape that is not
 * a pull-request URL is a named error rather than a guess.
 */
export function parsePullRequestUrl(url: string): PullRequestRef {
  const match = PULL_REQUEST_URL.exec(url.trim());
  if (match === null) {
    throw new Error(
      `"${url}" is not a GitHub pull-request URL ` +
        "(expected https://github.com/<owner>/<repo>/pull/<number>)",
    );
  }
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) {
    throw new Error(`"${url}" is not a GitHub pull-request URL`);
  }
  return { owner, repo, number: Number(number) };
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Right-hand line numbers a unified patch touches: every added line, and
 * every context line in between, since GitHub accepts a comment anchored
 * to any line inside a hunk it rendered.
 */
export function changedLinesOf(patch: string): readonly number[] {
  const lines: number[] = [];
  let cursor = 0;
  for (const patchLine of patch.split("\n")) {
    const header = HUNK_HEADER.exec(patchLine);
    if (header !== null) {
      cursor = Number(header[1]);
      continue;
    }
    if (cursor === 0) continue;
    if (patchLine.startsWith("-")) continue;
    if (patchLine.startsWith("+") || patchLine.startsWith(" ")) {
      lines.push(cursor);
      cursor += 1;
    }
  }
  return lines;
}

function requireApiKey(config: GitHubClientConfig, purpose: string): string {
  const apiKey = config.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      `${purpose} needs an authenticated GitHub credential; none was bound`,
    );
  }
  return apiKey;
}

function headers(apiKey: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

async function requestJSON(
  config: GitHubClientConfig,
  apiKey: string,
  url: URL,
  init: { readonly method: string; readonly body?: string },
): Promise<unknown> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    method: init.method,
    headers: headers(apiKey),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub ${init.method} ${url.pathname} failed: ` +
        `${String(response.status)} ${response.statusText}`,
    );
  }
  return response.json();
}

function baseOf(config: GitHubClientConfig): string {
  return config.baseUrl ?? DEFAULT_BASE_URL;
}

function pullPath(ref: PullRequestRef): string {
  return `/repos/${ref.owner}/${ref.repo}/pulls/${String(ref.number)}`;
}

function toFileDiff(
  file: typeof PullRequestFileResponse.infer,
): PullRequestFileDiff {
  const patch = file.patch;
  return {
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    ...(patch === undefined ? {} : { patch }),
    changedLines: patch === undefined ? [] : changedLinesOf(patch),
  };
}

/**
 * Fetches a pull request's metadata and per-file patches. Throws on any
 * transport, HTTP, or shape failure; a caller that needs graceful
 * degradation catches at its own boundary.
 */
export async function fetchPullRequestDiff(
  config: GitHubClientConfig,
  ref: PullRequestRef,
): Promise<PullRequestDiff> {
  const apiKey = requireApiKey(config, "reading a pull request's diff");
  const base = baseOf(config);

  const pullUrl = new URL(`${base}${pullPath(ref)}`);
  const filesUrl = new URL(`${base}${pullPath(ref)}/files`);
  filesUrl.searchParams.set("per_page", String(MAX_FILES_PER_PAGE));

  const [pullRaw, filesRaw] = await Promise.all([
    requestJSON(config, apiKey, pullUrl, { method: "GET" }),
    requestJSON(config, apiKey, filesUrl, { method: "GET" }),
  ]);

  const pull = PullRequestResponse(pullRaw);
  if (pull instanceof type.errors) {
    throw new Error(
      `GitHub pull-request response did not match the expected shape: ${pull.summary}`,
    );
  }
  const files = PullRequestFilesResponse(filesRaw);
  if (files instanceof type.errors) {
    throw new Error(
      `GitHub pull-request files response did not match the expected shape: ${files.summary}`,
    );
  }

  return {
    ref,
    title: pull.title,
    description: pull.body ?? "",
    url: pull.html_url,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    files: files.map(toFileDiff),
  };
}

/**
 * Posts one review on a pull request, as a comment-only review (never an
 * approval or a change request — a reviewer run says what it found; a
 * person decides what that means for the merge).
 */
export async function postPullRequestReview(
  config: GitHubClientConfig,
  ref: PullRequestRef,
  headSha: string,
  review: PullRequestReviewDraft,
): Promise<PostedPullRequestReview> {
  const apiKey = requireApiKey(config, "posting a pull-request review");
  if (review.body.trim().length === 0) {
    throw new Error("a posted pull-request review needs a non-empty body");
  }
  const url = new URL(`${baseOf(config)}${pullPath(ref)}/reviews`);
  const raw = await requestJSON(config, apiKey, url, {
    method: "POST",
    body: JSON.stringify({
      commit_id: headSha,
      body: review.body,
      event: "COMMENT",
      comments: review.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: "RIGHT",
        body: comment.body,
      })),
    }),
  });
  const posted = PostedReviewResponse(raw);
  if (posted instanceof type.errors) {
    throw new Error(
      `GitHub review response did not match the expected shape: ${posted.summary}`,
    );
  }
  return { id: posted.id, url: posted.html_url };
}
