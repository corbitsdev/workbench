import { describe, expect, test } from "bun:test";
import { redactExtra, redactText } from "./redact";

describe("redactText", () => {
  test("redacts a bearer token", () => {
    expect(redactText("failed calling api with Bearer abc123.def456")).toBe(
      "failed calling api with [redacted]",
    );
  });

  test("redacts an authorization header fragment", () => {
    expect(redactText("Authorization: sk-live-abcdefgh1234")).toBe(
      "[redacted]",
    );
  });

  test("redacts a recognizable key-prefixed secret", () => {
    expect(redactText("using key sk-abcdefgh1234 to call provider")).toBe(
      "using key [redacted] to call provider",
    );
  });

  test("leaves ordinary text untouched", () => {
    expect(redactText("could not reach the hub")).toBe(
      "could not reach the hub",
    );
  });
});

describe("redactExtra", () => {
  test("redacts a value whose key looks like a credential", () => {
    expect(
      redactExtra({ apiKey: "sk-abcdefgh1234", userId: "user_1" }),
    ).toEqual({ apiKey: "[redacted]", userId: "user_1" });
  });

  test("redacts nested objects by key", () => {
    expect(
      redactExtra({
        headers: { authorization: "Bearer abc.def", accept: "json" },
        repoIds: ["repo_1", "repo_2"],
      }),
    ).toEqual({
      headers: { authorization: "[redacted]", accept: "json" },
      repoIds: ["repo_1", "repo_2"],
    });
  });

  test("redacts an entire field whose key name itself looks secret-shaped", () => {
    // A field literally named "tokens" is redacted wholesale rather than
    // recursed into -- better to over-redact a suspicious key than miss a
    // real one nested inside it.
    expect(redactExtra({ tokens: ["tok_1", "tok_2"] })).toEqual({
      tokens: "[redacted]",
    });
  });

  test("scans plain string values for secret patterns even under a safe key", () => {
    expect(redactExtra({ detail: "rejected Bearer abc123" })).toEqual({
      detail: "rejected [redacted]",
    });
  });

  test("passes undefined through unchanged", () => {
    expect(redactExtra(undefined)).toBeUndefined();
  });
});
