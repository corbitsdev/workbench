// The one-origin contract: this app builds to a static directory, and the
// hub's HUB_STATIC_DIR must name that same directory, so the interface and
// the /api routes share an origin with no cross-origin configuration.

import { expect, test } from "bun:test";
import path from "node:path";

import config from "../vite.config";

const appDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(appDir, "../..");

test("assets are addressed from the origin root", () => {
  expect(config.base ?? "/").toBe("/");
});

test("the build lands where .env.example points the hub", async () => {
  const outDir = path.resolve(appDir, config.build?.outDir ?? "dist");
  const example = await Bun.file(path.join(repoRoot, ".env.example")).text();
  const staticDir = /^HUB_STATIC_DIR=(.+)$/m.exec(example)?.[1];
  if (staticDir === undefined) {
    throw new Error(".env.example does not set HUB_STATIC_DIR");
  }
  // The hub resolves a relative HUB_STATIC_DIR against its own working
  // directory, which is apps/hub under the dev bootstrap.
  const hubWorkingDir = path.join(repoRoot, "apps", "hub");
  expect(path.resolve(hubWorkingDir, staticDir)).toBe(outDir);
});
