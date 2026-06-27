import { describe, expect, test } from "bun:test";
import { isJunkItem, qualityFilter } from "./quality-filter";
import type { ResearchItem } from "./schema";

function makeItem(
  overrides: Partial<ResearchItem> & { url: string; title: string },
): ResearchItem {
  return {
    publishedAt: "2026-06-01T12:00:00Z",
    source: "hn",
    ...overrides,
  };
}

describe("isJunkItem GitHub traction floor (CL-2503)", () => {
  test("drops a low/zero-star repo that merely carries the topic word", () => {
    const item = makeItem({
      url: "https://github.com/someone/neobank",
      title: "someone/neobank: pet project",
      source: "github",
      engagement: { stars: 1 },
    });
    expect(isJunkItem(item)).toBe(true);
  });

  test("a repo with no star count is treated as zero-traction junk", () => {
    const item = makeItem({
      url: "https://github.com/x/neobank-demo",
      title: "x/neobank-demo",
      source: "github",
    });
    expect(isJunkItem(item)).toBe(true);
  });

  test("keeps a notable repo above the traction floor", () => {
    const item = makeItem({
      url: "https://github.com/real/project",
      title: "real/project: a notable launch",
      source: "github",
      engagement: { stars: 250 },
    });
    expect(isJunkItem(item)).toBe(false);
  });
});

describe("isJunkItem", () => {
  test("drops a bare social handle with no content", () => {
    const item = makeItem({
      url: "https://x.com/jack",
      title: "@jack",
      source: "x",
    });
    expect(isJunkItem(item)).toBe(true);
  });

  test("keeps a real post that merely mentions a handle", () => {
    const item = makeItem({
      url: "https://x.com/jack/status/1",
      title: "@jack on why agent mode changes how we ship",
      source: "x",
      engagement: { upvotes: 400 },
    });
    expect(isJunkItem(item)).toBe(false);
  });

  test("drops a clone/white-label repo by its -clone slug", () => {
    const item = makeItem({
      url: "https://github.com/miracuves/neobank-clone",
      title: "miracuves/neobank-clone",
      source: "github",
      engagement: { stars: 3 },
    });
    expect(isJunkItem(item)).toBe(true);
  });

  test("drops a white-label boilerplate repo by its launch-in-N-days phrasing", () => {
    const item = makeItem({
      url: "https://github.com/acme/fintech-starter",
      title: "Revolut clone, white-label fintech app, launch in 14 days",
      source: "github",
    });
    expect(isJunkItem(item)).toBe(true);
  });

  test("keeps a substantive github repo that is not a clone", () => {
    const item = makeItem({
      url: "https://github.com/anthropics/claude-agent-sdk",
      title: "anthropics/claude-agent-sdk",
      source: "github",
      engagement: { stars: 1200 },
    });
    expect(isJunkItem(item)).toBe(false);
  });

  test("drops a zero-signal social post with no engagement and no discussion", () => {
    const item = makeItem({
      url: "https://reddit.com/r/x/comments/1",
      title: "anyone else seeing this with the new release",
      source: "reddit",
      engagement: { upvotes: 0, comments: 0 },
    });
    expect(isJunkItem(item)).toBe(true);
  });

  test("keeps a low-engagement-but-substantive web article (never zero-signal-dropped)", () => {
    const item = makeItem({
      url: "https://blog.example.com/agent-mode-deep-dive",
      title: "A deep dive into autonomous agent mode and where it breaks",
      source: "web",
    });
    expect(isJunkItem(item)).toBe(false);
  });

  test("keeps a zero-engagement social post that still carries a top comment", () => {
    const item = makeItem({
      url: "https://reddit.com/r/x/comments/2",
      title: "agent mode first impressions",
      source: "reddit",
      engagement: { upvotes: 0 },
      topComments: [{ text: "this is the killer feature", score: 220 }],
    });
    expect(isJunkItem(item)).toBe(false);
  });
});

describe("qualityFilter", () => {
  test("removes junk and keeps the substantive items, preserving order", () => {
    const items = [
      makeItem({
        url: "https://blog.example.com/real",
        title: "A real article about the topic that has substance",
        source: "web",
      }),
      makeItem({ url: "https://x.com/h", title: "@handle", source: "x" }),
      makeItem({
        url: "https://github.com/foo/revolut-clone",
        title: "foo/revolut-clone",
        source: "github",
      }),
      makeItem({
        url: "https://hn.com/keep",
        title: "Hacker News thread worth keeping",
        source: "hn",
        engagement: { upvotes: 120 },
      }),
    ];
    const kept = qualityFilter(items);
    expect(kept.map((i) => i.url)).toEqual([
      "https://blog.example.com/real",
      "https://hn.com/keep",
    ]);
  });
});
