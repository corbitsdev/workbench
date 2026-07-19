import { describe, expect, test } from "bun:test";
import { escapeLikePattern } from "./like-pattern";

describe("escapeLikePattern", () => {
  test("escapes backslash, percent, and underscore", () => {
    expect(escapeLikePattern("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
  });

  test("escapes an underscore inside an otherwise plain id", () => {
    expect(escapeLikePattern("ses_abc123")).toBe("ses\\_abc123");
  });

  test("escapes backslash before percent/underscore so escaping itself cannot be exploited", () => {
    // A naive percent-then-backslash escape would turn "\%" into "\\%",
    // which LIKE reads as an escaped backslash followed by an unescaped
    // wildcard. Backslash must be escaped first.
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });

  test("returns an empty string unchanged", () => {
    expect(escapeLikePattern("")).toBe("");
  });
});
