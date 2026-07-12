import { describe, expect, test } from "bun:test";
import { extractMentions, formatMention, splitMentionSegments } from "./mentions";

const UUID = "252b009f-c844-4c23-8250-2db3815dabe7";

describe("extractMentions", () => {
  test("extracts a single mention and strips the usr_ marker", () => {
    expect(
      extractMentions(`hey @[Jane Doe](#usr_${UUID}) can you look`),
    ).toEqual([{ id: UUID, name: "Jane Doe" }]);
  });

  test("extracts multiple distinct mentions in order", () => {
    expect(
      extractMentions(
        "@[Jane Doe](#usr_abc123) and @[Bob Smith](#usr_def456) please review",
      ),
    ).toEqual([
      { id: "abc123", name: "Jane Doe" },
      { id: "def456", name: "Bob Smith" },
    ]);
  });

  test("dedupes a repeated mention, keeping the first occurrence's name", () => {
    expect(
      extractMentions(
        "@[Jane Doe](#usr_abc123) ping again @[Jane D.](#usr_abc123)",
      ),
    ).toEqual([{ id: "abc123", name: "Jane Doe" }]);
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

  test("ignores a bare-uuid href with no usr_ marker (the pre-fix composer bug)", () => {
    expect(extractMentions(`@[Sawyer - Test](#${UUID})`)).toEqual([]);
  });
});

describe("formatMention", () => {
  test("builds the wire-format token, adding the usr_ marker", () => {
    expect(formatMention(UUID, "Jane Doe")).toBe(`@[Jane Doe](#usr_${UUID})`);
  });
});

describe("mention wire format round trip", () => {
  test("a member refId survives format -> extract unchanged", () => {
    const refId = UUID;
    const token = formatMention(refId, "Sawyer");
    const [mention] = extractMentions(`${token} what's up?`);
    expect(mention).toEqual({ id: refId, name: "Sawyer" });
    // The extracted id is exactly what hub-side code compares against
    // session.user.id / principal.refId — both bare, unprefixed ids.
    expect(mention?.id).toBe(refId);
  });
});

describe("splitMentionSegments", () => {
  test("splits surrounding text from a mention pill", () => {
    expect(splitMentionSegments(`hi @[Bob](#usr_${UUID}) there`)).toEqual([
      { type: "text", value: "hi " },
      { type: "mention", id: UUID, name: "Bob" },
      { type: "text", value: " there" },
    ]);
  });

  test("returns a single text segment when there are no mentions", () => {
    expect(splitMentionSegments("no mentions here")).toEqual([
      { type: "text", value: "no mentions here" },
    ]);
  });

  test("handles a message that is only a mention", () => {
    expect(splitMentionSegments(`@[Bob](#usr_${UUID})`)).toEqual([
      { type: "mention", id: UUID, name: "Bob" },
    ]);
  });
});
