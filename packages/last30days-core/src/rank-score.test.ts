import { describe, expect, test } from "bun:test";
import { rankScore } from "./rank-score";
import type { Cluster } from "./cluster-merge";
import type { ResearchItem } from "./schema";

const NOW_ISO = "2026-06-11T12:00:00Z";

function makeItem(
  overrides: Partial<ResearchItem> & { url: string; title: string },
): ResearchItem {
  return {
    publishedAt: "2026-06-10T12:00:00Z",
    source: "hn",
    engagement: { upvotes: 100, comments: 10 },
    ...overrides,
  };
}

function makeCluster(items: ResearchItem[], id = "c1"): Cluster {
  const first = items[0];
  if (!first) throw new Error("cluster must have at least one item");
  return {
    id,
    items,
    sources: new Set(items.map((i) => i.source)),
    topItem: first,
  };
}

describe("rankScore", () => {
  test("returns clusters in descending score order", () => {
    const highEngagement = makeCluster(
      [
        makeItem({
          url: "https://a.com",
          title: "High",
          engagement: { upvotes: 1000, comments: 200 },
        }),
      ],
      "high",
    );
    const lowEngagement = makeCluster(
      [
        makeItem({
          url: "https://b.com",
          title: "Low",
          engagement: { upvotes: 10, comments: 1 },
        }),
      ],
      "low",
    );
    const result = rankScore([lowEngagement, highEngagement], {
      topic: "test",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("high");
    expect(result[1]?.id).toBe("low");
  });

  test("multi-source cluster outranks single-source cluster with equal raw engagement", () => {
    const singleSource = makeCluster(
      [
        makeItem({
          url: "https://a.com",
          title: "Single",
          engagement: { upvotes: 100, comments: 10 },
          source: "hn",
        }),
      ],
      "single",
    );
    const multiSource = makeCluster(
      [
        makeItem({
          url: "https://b.com",
          title: "Multi HN",
          engagement: { upvotes: 50, comments: 5 },
          source: "hn",
        }),
        makeItem({
          url: "https://c.com",
          title: "Multi Reddit",
          engagement: { upvotes: 50, comments: 5 },
          source: "reddit",
        }),
      ],
      "multi",
    );
    const result = rankScore([singleSource, multiSource], {
      topic: "test",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("multi");
  });

  test("degraded provenance cluster scores lower than equivalent clean cluster", () => {
    const clean = makeCluster(
      [
        makeItem({
          url: "https://a.com",
          title: "Clean",
          engagement: { upvotes: 100, comments: 10 },
        }),
      ],
      "clean",
    );
    const degraded = makeCluster(
      [
        makeItem({
          url: "https://b.com",
          title: "Degraded",
          engagement: { upvotes: 100, comments: 10 },
          provenance: "degraded",
        }),
      ],
      "degraded",
    );
    const result = rankScore([degraded, clean], {
      topic: "test",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("clean");
  });

  test("per-author cap limits items per author", () => {
    const manyFromOneAuthor = Array.from({ length: 10 }, (_, i) =>
      makeItem({
        url: `https://example.com/${i}`,
        title: `Post ${i}`,
        author: "prolific-author",
      }),
    );
    const cluster = makeCluster(manyFromOneAuthor, "many");
    const result = rankScore([cluster], {
      topic: "test",
      nowIso: NOW_ISO,
      maxPerAuthor: 3,
    });
    const authorCount =
      result[0]?.items.filter((i) => i.author === "prolific-author").length ??
      0;
    expect(authorCount).toBeLessThanOrEqual(3);
  });

  test("fresher cluster ranks higher than older cluster with same engagement", () => {
    const fresh = makeCluster(
      [
        makeItem({
          url: "https://a.com",
          title: "Fresh",
          publishedAt: "2026-06-11T11:00:00Z",
        }),
      ],
      "fresh",
    );
    const stale = makeCluster(
      [
        makeItem({
          url: "https://b.com",
          title: "Stale",
          publishedAt: "2026-05-01T00:00:00Z",
        }),
      ],
      "stale",
    );
    const result = rankScore([stale, fresh], {
      topic: "test",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("fresh");
  });

  test("deterministic: same inputs + same nowIso produces same order", () => {
    const clusters = [
      makeCluster(
        [
          makeItem({
            url: "https://a.com",
            title: "A",
            engagement: { upvotes: 50, comments: 5 },
          }),
        ],
        "a",
      ),
      makeCluster(
        [
          makeItem({
            url: "https://b.com",
            title: "B",
            engagement: { upvotes: 80, comments: 8 },
          }),
        ],
        "b",
      ),
    ];
    const first = rankScore(clusters, { topic: "test", nowIso: NOW_ISO }).map(
      (c) => c.id,
    );
    const second = rankScore(clusters, { topic: "test", nowIso: NOW_ISO }).map(
      (c) => c.id,
    );
    expect(first).toEqual(second);
  });

  test("cluster with a highly-upvoted top comment outranks an equivalent cluster without", () => {
    const withTopComment = makeCluster(
      [
        makeItem({
          url: "https://a.com",
          title: "Viral thread",
          engagement: { upvotes: 100, comments: 10 },
          topComments: [{ text: "the killer quote", score: 5000 }],
        }),
      ],
      "fun",
    );
    const plain = makeCluster(
      [
        makeItem({
          url: "https://b.com",
          title: "Plain thread",
          engagement: { upvotes: 100, comments: 10 },
        }),
      ],
      "plain",
    );
    const result = rankScore([plain, withTopComment], {
      topic: "test",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("fun");
  });

  test("a fractional top-comment score never demotes a cluster below a comment-less peer", () => {
    const fractional = makeCluster(
      [
        makeItem({
          url: "https://a.com",
          title: "Fractional",
          engagement: { upvotes: 100, comments: 10 },
          topComments: [{ text: "meh", score: 0.5 }],
        }),
      ],
      "fractional",
    );
    const plain = makeCluster(
      [
        makeItem({
          url: "https://b.com",
          title: "Plain",
          engagement: { upvotes: 100, comments: 10 },
        }),
      ],
      "plain",
    );
    const result = rankScore([fractional, plain], {
      topic: "test",
      nowIso: NOW_ISO,
    });
    const fractionalRank = result.findIndex((c) => c.id === "fractional");
    const plainRank = result.findIndex((c) => c.id === "plain");
    expect(fractionalRank).toBeLessThanOrEqual(plainRank);
  });

  test("empty input returns empty array", () => {
    expect(rankScore([], { topic: "test", nowIso: NOW_ISO })).toEqual([]);
  });

  // --- W1 reference-aligned relevance + source weighting (CL-2411) ---
  // The reference engine makes topic relevance the dominant signal and demotes
  // engagement to a capped nudge, so an off-topic viral item never wins. These
  // tests assert that behavior, not the exact internal weights.

  test("topic-relevant cluster outranks an off-topic cluster with far higher engagement", () => {
    const relevant = makeCluster(
      [
        makeItem({
          url: "https://a.com",
          title: "Anthropic ships a new Claude model",
          engagement: { upvotes: 40, comments: 5 },
          source: "hn",
        }),
      ],
      "relevant",
    );
    const offTopic = makeCluster(
      [
        makeItem({
          url: "https://b.com",
          title: "Rewrite Bun in Rust",
          engagement: { upvotes: 50000, comments: 4000 },
          source: "hn",
        }),
      ],
      "off-topic",
    );
    const result = rankScore([offTopic, relevant], {
      topic: "Anthropic",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("relevant");
  });

  test("a cluster that never names the topic is demoted below a grounded one", () => {
    const grounded = makeCluster(
      [
        makeItem({
          url: "https://a.com",
          title: "Anthropic introduces identity verification",
          engagement: { upvotes: 30, comments: 3 },
        }),
      ],
      "grounded",
    );
    const ungrounded = makeCluster(
      [
        makeItem({
          url: "https://b.com",
          title: "LangChain releases new agent framework",
          engagement: { upvotes: 9000, comments: 800 },
        }),
      ],
      "ungrounded",
    );
    const result = rankScore([ungrounded, grounded], {
      topic: "Anthropic",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("grounded");
  });

  test("a massive-star GitHub cluster does not outrank a topic-relevant social cluster", () => {
    const githubMegastars = makeCluster(
      [
        makeItem({
          url: "https://github.com/affaan-m/ECC",
          title: "ECC: agent harness performance optimization system",
          // Realistic normalized GitHub shape: stars, no upvotes/comments.
          engagement: { stars: 221734 },
          source: "github",
        }),
      ],
      "github",
    );
    const socialRelevant = makeCluster(
      [
        makeItem({
          url: "https://reddit.com/r/x",
          title: "Anthropic accused Alibaba of extracting Claude capabilities",
          engagement: { upvotes: 740, comments: 1195 },
          source: "reddit",
        }),
      ],
      "social",
    );
    const result = rankScore([githubMegastars, socialRelevant], {
      topic: "Anthropic",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("social");
  });

  test("a stale grounded cluster still outranks a fresh, viral, off-topic one", () => {
    const staleGrounded = makeCluster(
      [
        makeItem({
          url: "https://a.com",
          title: "Anthropic publishes a safety paper",
          engagement: { upvotes: 10, comments: 1 },
          publishedAt: "2026-05-14T00:00:00Z", // ~28 days old at NOW_ISO
          source: "hn",
        }),
      ],
      "stale-grounded",
    );
    const freshViral = makeCluster(
      [
        makeItem({
          url: "https://b.com",
          title: "LangChain ships a massive agent update",
          engagement: { upvotes: 80000, comments: 6000 },
          publishedAt: "2026-06-11T11:00:00Z",
          source: "hn",
        }),
        makeItem({
          url: "https://c.com",
          title: "Bun rewrite in Rust goes viral",
          engagement: { upvotes: 70000, comments: 5000 },
          publishedAt: "2026-06-11T10:00:00Z",
          source: "reddit",
        }),
      ],
      "fresh-viral",
    );
    const result = rankScore([freshViral, staleGrounded], {
      topic: "Anthropic",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("stale-grounded");
  });

  test("GitHub stars do not feed the engagement signal", () => {
    const githubStars = makeCluster(
      [
        makeItem({
          url: "https://github.com/x/y",
          title: "Anthropic Claude SDK",
          engagement: { stars: 1_000_000 },
          source: "github",
        }),
      ],
      "github-stars",
    );
    const redditVotes = makeCluster(
      [
        makeItem({
          url: "https://reddit.com/r/x",
          title: "Anthropic Claude SDK thread",
          engagement: { upvotes: 50, comments: 5 },
          source: "reddit",
        }),
      ],
      "reddit-votes",
    );
    // Equal grounding; stars contribute nothing, so the cluster with real
    // upvotes takes the engagement nudge and ranks first.
    const result = rankScore([githubStars, redditVotes], {
      topic: "Anthropic",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("reddit-votes");
  });

  test("engagement from a real-engagement source outweighs the same count from web (W1.4)", () => {
    const redditEngaged = makeCluster(
      [
        makeItem({
          url: "https://reddit.com/x",
          title: "Anthropic Claude discussion",
          engagement: { upvotes: 500, comments: 120 },
          source: "reddit",
        }),
      ],
      "reddit",
    );
    const webEngaged = makeCluster(
      [
        makeItem({
          url: "https://example.com/x",
          title: "Anthropic Claude writeup",
          engagement: { upvotes: 500, comments: 120 },
          source: "web",
        }),
      ],
      "web",
    );
    const result = rankScore([webEngaged, redditEngaged], {
      topic: "Anthropic",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("reddit");
  });

  test("an explicit per-item relevance score dominates ordering when present", () => {
    const highRelevance = makeCluster(
      [
        makeItem({
          url: "https://a.com",
          title: "Anthropic news",
          engagement: { upvotes: 20, comments: 2 },
          relevance: 95,
        }),
      ],
      "high-rel",
    );
    const lowRelevance = makeCluster(
      [
        makeItem({
          url: "https://b.com",
          title: "Anthropic news mirror",
          engagement: { upvotes: 800, comments: 90 },
          relevance: 8,
        }),
      ],
      "low-rel",
    );
    const result = rankScore([lowRelevance, highRelevance], {
      topic: "Anthropic",
      nowIso: NOW_ISO,
    });
    expect(result[0]?.id).toBe("high-rel");
  });

  test("handles mix of items with and without engagement", () => {
    const withEngagement = makeCluster(
      [
        makeItem({
          url: "https://a.com",
          title: "With Engagement",
          engagement: { upvotes: 100, comments: 10 },
        }),
      ],
      "with",
    );
    // makeItem sets engagement by default; create one without by casting
    const noEngItem = {
      url: "https://b.com",
      title: "No Engagement",
      publishedAt: "2026-06-10T12:00:00Z",
      source: "web" as const,
    } as ResearchItem;
    const withoutEngagement = makeCluster([noEngItem], "without");
    // Should not throw and should return both clusters
    const result = rankScore([withEngagement, withoutEngagement], {
      topic: "test",
      nowIso: NOW_ISO,
    });
    expect(result).toHaveLength(2);
  });
});
