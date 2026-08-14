import { describe, expect, test } from "bun:test";
import { parseSlackCredentials } from "./config";

describe("parseSlackCredentials", () => {
  test("accepts a well-formed credential pair", () => {
    expect(
      parseSlackCredentials({ botToken: "xoxb-1", signingSecret: "shh" }),
    ).toEqual({ botToken: "xoxb-1", signingSecret: "shh" });
  });

  test("rejects an empty bot token", () => {
    expect(() =>
      parseSlackCredentials({ botToken: "", signingSecret: "shh" }),
    ).toThrow();
  });

  test("rejects a missing signing secret", () => {
    expect(() => parseSlackCredentials({ botToken: "xoxb-1" })).toThrow();
  });
});
