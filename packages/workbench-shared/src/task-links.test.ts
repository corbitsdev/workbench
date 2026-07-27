import { describe, expect, it } from "bun:test";

import {
  isSafeHttpTaskUrl,
  resolveTaskLinkHref,
  validateTaskLinkRef,
  validateTaskLinks,
} from "./task-links";
import type { TaskLink } from "./tasks";

describe("validateTaskLinkRef", () => {
  it("accepts http(s) url links", () => {
    expect(
      validateTaskLinkRef({
        kind: "url",
        ref: "https://example.com/doc",
      }),
    ).toBeNull();
  });

  it("rejects javascript: url links", () => {
    expect(
      validateTaskLinkRef({
        kind: "url",
        ref: "javascript:alert(1)",
      }),
    ).toMatch(/http\(s\)/i);
  });

  it("rejects data: url links", () => {
    expect(
      validateTaskLinkRef({ kind: "url", ref: "data:text/html,x" }),
    ).toMatch(/http\(s\)/i);
  });

  it.each(["artifact", "workflow_run", "mail", "conversation"] as const)(
    "accepts a non-empty %s ref id",
    (kind) => {
      expect(validateTaskLinkRef({ kind, ref: "entity-1" })).toBeNull();
    },
  );

  it("rejects internal refs that look like URLs", () => {
    expect(
      validateTaskLinkRef({
        kind: "conversation",
        ref: "https://evil.example/thread",
      }),
    ).toMatch(/object id/i);
  });

  it("rejects whitespace-padded internal refs", () => {
    expect(validateTaskLinkRef({ kind: "mail", ref: " pm-1" })).toMatch(
      /whitespace/i,
    );
  });
});

describe("validateTaskLinks", () => {
  it("returns the index of the first invalid link", () => {
    const links: TaskLink[] = [
      { kind: "workflow_run", ref: "run-1" },
      { kind: "url", ref: "javascript:x" },
    ];
    expect(validateTaskLinks(links)).toBe(
      "links[1]: url links must be absolute http(s) URLs",
    );
  });
});

describe("resolveTaskLinkHref", () => {
  it("maps conversation links to /chats/:ref", () => {
    expect(resolveTaskLinkHref({ kind: "conversation", ref: "thread-1" })).toBe(
      "/chats/thread-1",
    );
  });

  it("returns null for unsafe stored url links", () => {
    expect(
      resolveTaskLinkHref({ kind: "url", ref: "javascript:alert(1)" }),
    ).toBeNull();
  });
});

describe("isSafeHttpTaskUrl", () => {
  it("requires an absolute URL", () => {
    expect(isSafeHttpTaskUrl("/relative")).toBe(false);
    expect(isSafeHttpTaskUrl("https://x.test/y")).toBe(true);
  });
});
