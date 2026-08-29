import { describe, expect, test } from "bun:test";

import { CODE_REVIEW_REVIEWERS } from "./reviewers";
import { reviewerIntroductions } from "./introductions";

const REPO_NAMES = ["acme/widgets", "acme/gadgets"];

describe("reviewerIntroductions", () => {
  test("returns one introduction per reviewer, in roster order", () => {
    const introductions = reviewerIntroductions(REPO_NAMES);
    expect(introductions.map((introduction) => introduction.handle)).toEqual(
      CODE_REVIEW_REVIEWERS.map((reviewer) => reviewer.handle),
    );
  });

  test("every introduction names a picked repo and carries no internal detail", () => {
    const introductions = reviewerIntroductions(REPO_NAMES);
    for (const { handle, text } of introductions) {
      expect(REPO_NAMES.some((name) => text.includes(name))).toBe(true);
      expect(text).not.toContain("@");
      expect(text.toLowerCase()).not.toContain("http");
      expect(text).not.toContain(handle);
    }
  });

  test("names the single picked repo when only one is selected", () => {
    const introductions = reviewerIntroductions(["acme/widgets"]);
    for (const { text } of introductions) {
      expect(text).toContain("acme/widgets");
    }
  });
});
