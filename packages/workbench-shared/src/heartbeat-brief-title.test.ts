import { describe, expect, test } from "bun:test";
import {
  formatBriefDateDdMmYy,
  formatHeartbeatBriefTitle,
  morningBriefArtifactKind,
} from "./heartbeat-brief-title";

const JULY_4_2026_UTC = Date.UTC(2026, 6, 4, 8, 0, 0);

describe("morningBriefArtifactKind", () => {
  test("is the stable 'morning-brief' literal, never 'report'", () => {
    expect(morningBriefArtifactKind()).toBe("morning-brief");
  });
});

describe("formatBriefDateDdMmYy", () => {
  test("formats a UTC instant as DD/MM/YY", () => {
    expect(formatBriefDateDdMmYy(JULY_4_2026_UTC)).toBe("04/07/26");
  });

  test("pads single-digit day and month", () => {
    expect(formatBriefDateDdMmYy(Date.UTC(2026, 0, 9, 0, 0, 0))).toBe(
      "09/01/26",
    );
  });
});

describe("formatHeartbeatBriefTitle", () => {
  test("uses the possessive form of the user's display name", () => {
    expect(formatHeartbeatBriefTitle("Jordan Lee", JULY_4_2026_UTC)).toBe(
      "Jordan Lee's Morning Brief - 04/07/26",
    );
  });

  test("falls back to 'Your Morning Brief' when no display name is known", () => {
    expect(formatHeartbeatBriefTitle(undefined, JULY_4_2026_UTC)).toBe(
      "Your Morning Brief - 04/07/26",
    );
  });

  test("falls back when the display name is blank", () => {
    expect(formatHeartbeatBriefTitle("   ", JULY_4_2026_UTC)).toBe(
      "Your Morning Brief - 04/07/26",
    );
  });

  test("trims a display name with surrounding whitespace", () => {
    expect(formatHeartbeatBriefTitle("  Jordan Lee  ", JULY_4_2026_UTC)).toBe(
      "Jordan Lee's Morning Brief - 04/07/26",
    );
  });
});
