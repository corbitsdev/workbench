// Pull-request reads and one write, on top of the same minimal REST
// client `./client.ts` uses for search. Both calls here need a real
// credential in practice — a private diff is not readable keylessly and
// posting a review is a write — but which shape that credential takes is
// the caller's business: a mediated `fetch` that injects the secret
// itself, or a token passed as `apiKey`. This module only sends what it
// was given, so "not connected" is decided where the credential is
// resolved, never guessed at here.
//
// The right-hand line numbers a patch actually touches are parsed out of
// each file's hunk headers. GitHub rejects a review comment anchored to
// a line outside the diff, so a caller that wants inline comments has to
// know which lines are anchorable before it posts — that is what
// `changedLines` is for.
import { type } from "arktype";

import type { GitHubClientConfig } from "./client";

const DEFAULT_BASE_URL = "https://api.github.com";
const MAX_ITEMS_PER_PAGE = 100;
/**
 * Upper bound on how many pages a paginated fetch follows. A pull
 * request with more than 3,000 changed files or review comments is
 * pathological; past that we stop and say so rather than loop forever.
 */
const MAX_PAGES = 30;

const PullRequestResponse = type({
  title: "string",
  "body?": "string | null",
  user: { login: "string" },
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
  /** The pull request's author login; a bot login skips review entirely. */
  readonly author: string;
  /** The head commit a posted review is anchored to. */
  readonly headSha: string;
  readonly baseSha: string;
  readonly files: readonly PullRequestFileDiff[];
  /** True when the file list hit the page bound and may be incomplete. */
  readonly truncated: boolean;
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

export interface PullRequestReviewCommentsPage {
  readonly comments: readonly string[];
  /** True when the comment list hit the page bound and may be incomplete. */
  readonly truncated: boolean;
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

function headers(apiKey: string | undefined): Record<string, string> {
  const base: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };
  if (apiKey !== undefined && apiKey.length > 0) {
    base.authorization = `Bearer ${apiKey}`;
  }
  return base;
}

/**
 * Fetches a URL and parses its body as JSON, throwing one consistently
 * worded error for a non-2xx response. The one seam every GitHub call in
 * this module goes through, so `requestJSON` and `fetchAllPages` report
 * a transport failure identically instead of each spelling it out.
 */
async function fetchJSON(
  config: GitHubClientConfig,
  url: URL,
  init: { readonly method: string; readonly body?: string },
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const doFetch = config.fetchImpl ?? fetch;
  const response: Response = await doFetch(url, {
    method: init.method,
    headers: headers(config.apiKey),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub ${init.method} ${url.pathname} failed: ` +
        `${String(response.status)} ${response.statusText}`,
    );
  }
  return { response, body: await response.json() };
}

async function requestJSON(
  config: GitHubClientConfig,
  url: URL,
  init: { readonly method: string; readonly body?: string },
): Promise<unknown> {
  return (await fetchJSON(config, url, init)).body;
}

const NEXT_LINK = /<([^>]+)>\s*;\s*rel="next"/;

/** Reads the `rel="next"` URL out of a GitHub `Link` response header. */
function nextPageUrl(linkHeader: string | null): URL | null {
  if (linkHeader === null) return null;
  const match = NEXT_LINK.exec(linkHeader);
  return match?.[1] === undefined ? null : new URL(match[1]);
}

/** The next page to request when a paginated endpoint sent no `Link`. */
function fallbackNextPage(url: URL, pageItemCount: number): URL | null {
  if (pageItemCount < MAX_ITEMS_PER_PAGE) return null;
  const next = new URL(url);
  const currentPage = Number(next.searchParams.get("page") ?? "1");
  next.searchParams.set("page", String(currentPage + 1));
  return next;
}

/**
 * Follows a paginated GitHub list endpoint to completion: the `Link`
 * header's `rel="next"` when GitHub sends one, otherwise successive
 * `page=` requests until a page comes back short. Stops at `MAX_PAGES`
 * and reports `truncated: true` rather than looping forever against a
 * pathological pull request.
 */
async function fetchAllPages(
  config: GitHubClientConfig,
  initialUrl: URL,
): Promise<{
  readonly items: readonly unknown[];
  readonly truncated: boolean;
}> {
  const items: unknown[] = [];
  let url: URL | null = initialUrl;
  let pageCount = 0;
  let truncated = false;

  while (url !== null) {
    if (pageCount >= MAX_PAGES) {
      truncated = true;
      break;
    }
    pageCount += 1;
    const { response, body: page } = await fetchJSON(config, url, {
      method: "GET",
    });
    if (!Array.isArray(page)) {
      throw new Error(`GitHub GET ${url.pathname} returned a non-array page`);
    }
    items.push(...page);
    url =
      nextPageUrl(response.headers.get("link")) ??
      fallbackNextPage(url, page.length);
  }

  return { items, truncated };
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
  const base = baseOf(config);

  const pullUrl = new URL(`${base}${pullPath(ref)}`);
  const filesUrl = new URL(`${base}${pullPath(ref)}/files`);
  filesUrl.searchParams.set("per_page", String(MAX_ITEMS_PER_PAGE));

  const [pullRaw, filesPage] = await Promise.all([
    requestJSON(config, pullUrl, { method: "GET" }),
    fetchAllPages(config, filesUrl),
  ]);

  const pull = PullRequestResponse(pullRaw);
  if (pull instanceof type.errors) {
    throw new Error(
      `GitHub pull-request response did not match the expected shape: ${pull.summary}`,
    );
  }
  const files = PullRequestFilesResponse(filesPage.items);
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
    author: pull.user.login,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    files: files.map(toFileDiff),
    truncated: filesPage.truncated,
  };
}

const ReviewCommentResponse = type({ body: "string" });
const ReviewCommentsResponse = ReviewCommentResponse.array();

/**
 * Reads every review comment already posted on a pull request. A re-run
 * uses this to find which findings it already posted, by the fingerprint
 * marker embedded in each comment's body — never by re-reading the model.
 */
export async function fetchPullRequestReviewComments(
  config: GitHubClientConfig,
  ref: PullRequestRef,
): Promise<PullRequestReviewCommentsPage> {
  const url = new URL(`${baseOf(config)}${pullPath(ref)}/comments`);
  url.searchParams.set("per_page", String(MAX_ITEMS_PER_PAGE));
  const page = await fetchAllPages(config, url);
  const comments = ReviewCommentsResponse(page.items);
  if (comments instanceof type.errors) {
    throw new Error(
      `GitHub pull-request comments response did not match the expected shape: ${comments.summary}`,
    );
  }
  return {
    comments: comments.map((comment) => comment.body),
    truncated: page.truncated,
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
  if (review.body.trim().length === 0) {
    throw new Error("a posted pull-request review needs a non-empty body");
  }
  const url = new URL(`${baseOf(config)}${pullPath(ref)}/reviews`);
  const raw = await requestJSON(config, url, {
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
