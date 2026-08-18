import { describe, expect, test } from "bun:test";

import { insertTextAtCaret } from "./composer";

describe("insertTextAtCaret", () => {
  test("splices the insertion in at the caret", () => {
    const result = insertTextAtCaret("hello world", 6, "@myra ");
    expect(result.text).toBe("hello @myra world");
    expect(result.caret).toBe(12);
  });

  test("appends at the end when the caret sits past the text", () => {
    const result = insertTextAtCaret("hi", 2, "@myra ");
    expect(result.text).toBe("hi@myra ");
    expect(result.caret).toBe(8);
  });

  test("inserts into an empty draft", () => {
    const result = insertTextAtCaret("", 0, "@myra ");
    expect(result.text).toBe("@myra ");
    expect(result.caret).toBe(6);
  });
});
