import { describe, expect, test } from "bun:test";

import {
  AUTO_WORKBENCH_TITLE_MAX,
  autoNameFromFirstMessage,
  NEW_WORKBENCH_TITLE,
  titleFromFirstMessage,
} from "./auto-workbench-title";

describe("titleFromFirstMessage (CL-6656)", () => {
  test("trims and collapses whitespace into a single-line title", () => {
    expect(titleFromFirstMessage("  Help me\nplan  Q3  ")).toBe(
      "Help me plan Q3",
    );
  });

  test("returns undefined for blank or whitespace-only input", () => {
    expect(titleFromFirstMessage("")).toBeUndefined();
    expect(titleFromFirstMessage("   \n\t  ")).toBeUndefined();
  });

  test("keeps a short message intact", () => {
    expect(titleFromFirstMessage("Draft a launch checklist")).toBe(
      "Draft a launch checklist",
    );
  });

  test("truncates a long message at a word boundary with an ellipsis", () => {
    const long =
      "Help me write a detailed competitive analysis of every agent coding tool shipping this quarter";
    const title = titleFromFirstMessage(long);
    expect(title).toBeDefined();
    expect(title!.endsWith("…")).toBe(true);
    expect(title!.length).toBeLessThanOrEqual(AUTO_WORKBENCH_TITLE_MAX + 1);
    expect(title).not.toContain("shipping");
  });
});

describe("autoNameFromFirstMessage (CL-6656)", () => {
  test("names an ad-hoc New Workbench from the first message", () => {
    expect(
      autoNameFromFirstMessage(NEW_WORKBENCH_TITLE, "Plan the Q3 launch"),
    ).toBe("Plan the Q3 launch");
  });

  test("leaves prefab and already-renamed titles alone", () => {
    expect(
      autoNameFromFirstMessage("Code review", "Review the auth PR"),
    ).toBeUndefined();
    expect(
      autoNameFromFirstMessage("My research bench", "Dig into pricing"),
    ).toBeUndefined();
  });

  test("returns undefined when the first message has no usable text", () => {
    expect(autoNameFromFirstMessage(NEW_WORKBENCH_TITLE, "   ")).toBeUndefined();
  });
});
