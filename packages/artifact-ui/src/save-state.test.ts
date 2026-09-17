import { describe, expect, test } from "bun:test";
import { formatSaveStateLine, formatSavedLabel } from "./save-state";

describe("formatSavedLabel", () => {
  test("under a minute reads 'just now'", () => {
    expect(formatSavedLabel(1_000, 1_000 + 30_000)).toBe("Saved just now");
  });

  test("minutes ago", () => {
    expect(formatSavedLabel(0, 5 * 60_000)).toBe("Saved 5m ago");
  });

  test("hours ago", () => {
    expect(formatSavedLabel(0, 3 * 60 * 60_000)).toBe("Saved 3h ago");
  });

  test("a full day or more falls back to a bare 'Saved' rather than a stale hour count", () => {
    expect(formatSavedLabel(0, 25 * 60 * 60_000)).toBe("Saved");
  });
});

describe("formatSaveStateLine", () => {
  test("read-only renders nothing", () => {
    expect(formatSaveStateLine({ kind: "read-only" }, 0)).toBe("");
  });

  test("saving reads a plain in-flight ellipsis", () => {
    expect(formatSaveStateLine({ kind: "saving" }, 0)).toBe("Saving…");
  });

  test("saved combines the relative-time label with the version, never claiming a version that wasn't confirmed", () => {
    expect(
      formatSaveStateLine({ kind: "saved", version: 12, savedAt: 0 }, 30_000),
    ).toBe("Saved just now · v12");
  });

  test("unsaved is honest about not having confirmed a write yet", () => {
    expect(formatSaveStateLine({ kind: "unsaved" }, 0)).toBe("Unsaved changes");
  });
});
