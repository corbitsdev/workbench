import { expect, test } from "bun:test";

import { templateSettingsPatch } from "../src/settings";

test("builds a valid template/* settings patch", () => {
  expect(templateSettingsPatch("code-review", ["github"])).toEqual({
    "template/id": "code-review",
    "template/pendingConnections": ["github"],
  });
});

test("rejects an empty template id", () => {
  expect(() => templateSettingsPatch("", ["github"])).toThrow(
    /invalid template settings patch/,
  );
});
