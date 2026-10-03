import { describe, expect, test } from "bun:test";

import { toolCountLabel } from "./tool-count";

describe("toolCountLabel", () => {
  test("singular for one tool", () => {
    expect(toolCountLabel(1)).toBe("1 tool");
  });

  test("plural otherwise", () => {
    expect(toolCountLabel(0)).toBe("0 tools");
    expect(toolCountLabel(3)).toBe("3 tools");
  });
});
