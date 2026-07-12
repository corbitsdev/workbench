import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  CHANGELOG,
  ChangelogReleaseSchema,
  compareVersions,
  hasUnseenChangelog,
  latestChangelogRelease,
  latestChangelogVersion,
} from "./changelog";

describe("CHANGELOG", () => {
  test("every release validates against the release schema", () => {
    for (const release of CHANGELOG) {
      const parsed = ChangelogReleaseSchema(release);
      expect(parsed instanceof type.errors).toBe(false);
    }
  });

  test("is ordered newest first", () => {
    for (let i = 0; i < CHANGELOG.length - 1; i += 1) {
      expect(
        compareVersions(CHANGELOG[i]!.version, CHANGELOG[i + 1]!.version),
      ).toBeGreaterThan(0);
    }
  });

  test("every release has at least one entry", () => {
    for (const release of CHANGELOG) {
      expect(release.entries.length).toBeGreaterThan(0);
    }
  });

  test("latestChangelogVersion returns the first release's version", () => {
    expect(latestChangelogVersion()).toBe(CHANGELOG[0]!.version);
  });

  test("latestChangelogRelease returns the first release", () => {
    expect(latestChangelogRelease()).toBe(CHANGELOG[0]);
  });
});

describe("compareVersions", () => {
  test("returns 0 for equal versions", () => {
    expect(compareVersions("0.6.0", "0.6.0")).toBe(0);
  });

  test("returns negative when the first version is older", () => {
    expect(compareVersions("0.5.9", "0.6.0")).toBeLessThan(0);
    expect(compareVersions("0.6.0", "0.6.1")).toBeLessThan(0);
    expect(compareVersions("0.6.0", "1.0.0")).toBeLessThan(0);
  });

  test("returns positive when the first version is newer", () => {
    expect(compareVersions("0.6.1", "0.6.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  test("treats missing segments as 0", () => {
    expect(compareVersions("0.6", "0.6.0")).toBe(0);
    expect(compareVersions("0.6", "0.6.1")).toBeLessThan(0);
  });
});

describe("hasUnseenChangelog", () => {
  test("is true for an empty seen version", () => {
    expect(hasUnseenChangelog("")).toBe(true);
  });

  test("is true when the seen version is older than the latest", () => {
    expect(hasUnseenChangelog("0.5.9")).toBe(true);
  });

  test("is false when the seen version matches the latest", () => {
    expect(hasUnseenChangelog(latestChangelogVersion())).toBe(false);
  });

  test("is false when the seen version is newer than the latest", () => {
    const [major, minor, patch] = latestChangelogVersion()
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    expect(hasUnseenChangelog(`${major}.${minor}.${(patch ?? 0) + 1}`)).toBe(
      false,
    );
  });
});
