import { describe, expect, test } from "bun:test";
import { extractMentions, formatMention } from "./mentions";

describe("extractMentions", () => {
  test("extracts a single mention", () => {
    expect(
      extractMentions("hey @[Jane Doe](#usr_abc123) can you look"),
    ).toEqual([{ id: "usr_abc123", name: "Jane Doe" }]);
  });

  test("extracts multiple distinct mentions in order", () => {
    expect(
      extractMentions(
        "@[Jane Doe](#usr_abc123) and @[Bob Smith](#usr_def456) please review",
      ),
    ).toEqual([
      { id: "usr_abc123", name: "Jane Doe" },
      { id: "usr_def456", name: "Bob Smith" },
    ]);
  });

  test("dedupes a repeated mention, keeping the first occurrence's name", () => {
    expect(
      extractMentions(
        "@[Jane Doe](#usr_abc123) ping again @[Jane D.](#usr_abc123)",
      ),
    ).toEqual([{ id: "usr_abc123", name: "Jane Doe" }]);
  });

  test("returns empty array for plain text with no mentions", () => {
    expect(extractMentions("no mentions here")).toEqual([]);
  });

  test("ignores a markdown link that is not a usr_ mention", () => {
    expect(extractMentions("see [the docs](https://example.com)")).toEqual([]);
  });

  test("ignores malformed mention syntax", () => {
    expect(extractMentions("@[broken(#usr_abc123)")).toEqual([]);
    expect(extractMentions("@[Jane Doe](abc123)")).toEqual([]);
  });
});

describe("formatMention", () => {
  test("builds the wire-format token", () => {
    expect(formatMention("usr_abc123", "Jane Doe")).toBe(
      "@[Jane Doe](#usr_abc123)",
    );
  });
});
