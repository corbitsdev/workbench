import { describe, expect, test } from "bun:test";

import { detailPathForName } from "./detail-paths";

describe("detailPathForName", () => {
  test("a slug-shaped name addresses its own detail route", () => {
    expect(detailPathForName("/agents", "weekly-digest")).toBe(
      "/agents/weekly-digest",
    );
  });

  test("a display name is slugified into the detail path", () => {
    expect(detailPathForName("/plugins", "Linear MCP")).toBe(
      "/plugins/linear-mcp",
    );
  });

  test("a name with nothing sluggable in it falls back to the roster", () => {
    expect(detailPathForName("/skills", "✨")).toBe("/skills");
    expect(detailPathForName("/skills", "   ")).toBe("/skills");
  });
});
