import { expect, test } from "bun:test";

import { searchReddit, searchSubreddit } from "./client";

const RAW_POST_EPOCH = {
  title: "Anyone using a tool for this?",
  url: "https://reddit.com/r/startups/comments/abc123/anyone_using_a_tool_for_this",
  permalink: "/r/startups/comments/abc123/anyone_using_a_tool_for_this",
  subreddit: "startups",
  created_utc: 1770000000,
  ups: 42,
  num_comments: 7,
};

const RAW_POST_ISO = {
  title: "Frustrated with our current workflow",
  url: "https://reddit.com/r/smallbusiness/comments/def456/frustrated",
  permalink: "/r/smallbusiness/comments/def456/frustrated",
  subreddit: "smallbusiness",
  created_at: "2026-08-01T12:00:00.000Z",
  upvotes: 11,
  comments: 3,
};

test("searchReddit returns parsed posts, tolerating the epoch created_utc shape", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ posts: [RAW_POST_EPOCH] }), {
      status: 200,
    })) as unknown as typeof fetch;

  const posts = await searchReddit(
    { apiKey: "test-key", fetchImpl },
    { query: "workflow tool" },
  );
  expect(posts).toEqual([
    {
      title: "Anyone using a tool for this?",
      url: "https://reddit.com/r/startups/comments/abc123/anyone_using_a_tool_for_this",
      permalink: "/r/startups/comments/abc123/anyone_using_a_tool_for_this",
      subreddit: "startups",
      createdAt: new Date(1770000000 * 1000).toISOString(),
      upvotes: 42,
      numComments: 7,
    },
  ]);
});

test("searchSubreddit returns parsed posts, tolerating the ISO created_at shape", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: [RAW_POST_ISO] }), {
      status: 200,
    })) as unknown as typeof fetch;

  const posts = await searchSubreddit(
    { apiKey: "test-key", fetchImpl },
    { subreddit: "smallbusiness", query: "workflow" },
  );
  expect(posts).toEqual([
    {
      title: "Frustrated with our current workflow",
      url: "https://reddit.com/r/smallbusiness/comments/def456/frustrated",
      permalink: "/r/smallbusiness/comments/def456/frustrated",
      subreddit: "smallbusiness",
      createdAt: "2026-08-01T12:00:00.000Z",
      upvotes: 11,
      numComments: 3,
    },
  ]);
});

test("posts the api key as the x-api-key header", async () => {
  const captured: { key: string | null } = { key: null };
  const fetchImpl = (async (_input: URL | string, init?: RequestInit) => {
    captured.key =
      (init?.headers as Record<string, string> | undefined)?.["x-api-key"] ??
      null;
    return new Response(JSON.stringify({ posts: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await searchReddit({ apiKey: "secret", fetchImpl }, { query: "anything" });
  expect(captured.key).toBe("secret");
});

test("throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 401 })) as unknown as typeof fetch;

  await expect(
    searchReddit({ apiKey: "bad", fetchImpl }, { query: "anything" }),
  ).rejects.toThrow(/401/);
});

test("drops posts that do not match the expected shape rather than throwing", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ posts: [{ title: "no permalink here" }] }), {
      status: 200,
    })) as unknown as typeof fetch;

  const posts = await searchReddit(
    { apiKey: "test-key", fetchImpl },
    { query: "anything" },
  );
  expect(posts).toEqual([]);
});

test("returns no posts when the response body has no recognizable list", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ unexpected: true }), {
      status: 200,
    })) as unknown as typeof fetch;

  const posts = await searchSubreddit(
    { apiKey: "test-key", fetchImpl },
    { subreddit: "startups", query: "anything" },
  );
  expect(posts).toEqual([]);
});
