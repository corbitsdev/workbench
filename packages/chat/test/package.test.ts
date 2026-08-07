import { describe, expect, test } from "bun:test";
import { CHAT_PACKAGE_NAME } from "../src/index";

describe("@corbits/chat", () => {
  test("exports its package name as a placeholder", () => {
    expect(CHAT_PACKAGE_NAME).toBe("@corbits/chat");
  });
});
