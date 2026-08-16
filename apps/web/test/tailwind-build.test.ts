// Guards the Tailwind v4 cutover: known app-authored utilities (grids,
// artifact kind palette) must appear in the production CSS bundle.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const WEB_ROOT = path.resolve(import.meta.dir, "..");
const DIST_ASSETS = path.join(WEB_ROOT, "dist/assets");

function builtCss(): string {
  if (!existsSync(DIST_ASSETS)) {
    throw new Error(
      "apps/web/dist/assets missing — run `bun run build` in apps/web first",
    );
  }
  const file = readdirSync(DIST_ASSETS).find((name) => name.endsWith(".css"));
  if (file === undefined) {
    throw new Error("no CSS asset under apps/web/dist/assets");
  }
  return readFileSync(path.join(DIST_ASSETS, file), "utf8");
}

describe("Tailwind production CSS", () => {
  test("emits grid auto-fill utilities used by Agents and Library", () => {
    const css = builtCss();
    expect(css).toContain("grid-cols-");
    expect(css).toContain("sm\\:px-7");
  });

  // The kind-color palette classes died with artifact-ui's unused
  // `artifactKindColor` export (fleet cleanup) — kind is conveyed by
  // `artifactKindLabel` text, so only the still-used neutral survives.
  test("emits the artifact card's neutral background", () => {
    const css = builtCss();
    expect(css).toContain("bg-muted");
  });

  test("emits sizing utilities used on agent cards", () => {
    const css = builtCss();
    expect(css).toContain("w-fit");
    expect(css).toContain("min-h-");
  });
});
