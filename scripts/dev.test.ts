// Unit gate for dev.ts's skip-rebuild decision: whether the existing
// web bundle already matches every file the build reads, so `bun run
// dev` can skip paying for another full vite build before the hub
// serves it.

import { describe, expect, test } from "bun:test";

import { isWebBuildFresh } from "./dev.ts";

describe("isWebBuildFresh", () => {
  test("stale when the dist bundle has never been built", () => {
    expect(isWebBuildFresh(1_000, null)).toBe(false);
  });

  test("stale when a source file is newer than the dist bundle", () => {
    expect(isWebBuildFresh(2_000, 1_000)).toBe(false);
  });

  test("stale when the dist bundle and the source share a timestamp", () => {
    expect(isWebBuildFresh(1_000, 1_000)).toBe(false);
  });

  test("fresh when the dist bundle is newer than every source file", () => {
    expect(isWebBuildFresh(1_000, 2_000)).toBe(true);
  });
});
