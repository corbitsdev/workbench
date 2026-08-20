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
  // Code splitting emits one CSS file per chunk; a utility may land in
  // any of them, so assert against all of them together.
  const files = readdirSync(DIST_ASSETS).filter((name) =>
    name.endsWith(".css"),
  );
  if (files.length === 0) {
    throw new Error("no CSS asset under apps/web/dist/assets");
  }
  return files
    .map((file) => readFileSync(path.join(DIST_ASSETS, file), "utf8"))
    .join("\n");
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
