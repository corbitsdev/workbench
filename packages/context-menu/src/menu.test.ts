import { describe, expect, test } from "bun:test";

import {
  contextMenuItem,
  contextMenuSeparator,
  isContextMenuEmpty,
} from "./menu";

describe("contextMenuItem", () => {
  test("stamps the item kind", () => {
    const item = contextMenuItem({
      id: "open",
      label: "Open",
      onSelect: () => undefined,
    });
    expect(item.kind).toBe("item");
    expect(item.id).toBe("open");
  });
});

describe("isContextMenuEmpty", () => {
  test("true for null", () => {
    expect(isContextMenuEmpty(null)).toBe(true);
  });

  test("true for a menu with only separators", () => {
    expect(
      isContextMenuEmpty({
        entries: [contextMenuSeparator, contextMenuSeparator],
      }),
    ).toBe(true);
  });

  test("true for a menu with no entries at all", () => {
    expect(isContextMenuEmpty({ entries: [] })).toBe(true);
  });

  test("false once a real item is present", () => {
    expect(
      isContextMenuEmpty({
        entries: [
          contextMenuSeparator,
          contextMenuItem({
            id: "open",
            label: "Open",
            onSelect: () => undefined,
          }),
        ],
      }),
    ).toBe(false);
  });
});
