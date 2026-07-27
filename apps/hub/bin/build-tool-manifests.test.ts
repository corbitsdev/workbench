import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  loadCommittedToolManifestFactories,
  sortFactoryManifests,
} from "@workbench/tool-manifest";
import {
  buildToolManifestIndex,
  collectToolFactoryManifests,
  renderToolManifestModule,
  toolManifestIndexPath,
} from "./build-tool-manifests.ts";

// collectToolFactoryManifests() dynamically imports every tool package's
// manifest module on first invocation in a process (~9s cold), which blows
// past bun's default 5000ms test timeout. Pre-existing, unrelated to this
// file's determinism assertions — every test that calls it needs the same
// explicit override.
const SLOW_MANIFEST_COLLECTION_TIMEOUT = 30_000;

describe("build-tool-manifests", () => {
  test(
    "committed index.json matches live package manifests",
    async () => {
      const live = sortFactoryManifests(await collectToolFactoryManifests());
      const raw = JSON.parse(readFileSync(toolManifestIndexPath(), "utf8")) as {
        factories: unknown;
      };
      const committed = sortFactoryManifests(
        raw.factories as Parameters<typeof sortFactoryManifests>[0],
      );
      expect(live).toEqual(committed);
    },
    SLOW_MANIFEST_COLLECTION_TIMEOUT,
  );

  test(
    "committed generated module matches live package manifests",
    async () => {
      const live = sortFactoryManifests(await collectToolFactoryManifests());
      expect(loadCommittedToolManifestFactories()).toEqual(live);
    },
    SLOW_MANIFEST_COLLECTION_TIMEOUT,
  );

  test(
    "regenerating twice from unchanged source is fully deterministic",
    async () => {
      const first = await buildToolManifestIndex();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await buildToolManifestIndex();

      expect(first.generatedAt).toEqual(second.generatedAt);
      expect(JSON.stringify(first, null, 2)).toEqual(
        JSON.stringify(second, null, 2),
      );
      expect(await renderToolManifestModule(first)).toEqual(
        await renderToolManifestModule(second),
      );
    },
    SLOW_MANIFEST_COLLECTION_TIMEOUT,
  );

  test(
    "bundled module never embeds the generatedAt field",
    async () => {
      const index = await buildToolManifestIndex();
      const rendered = await renderToolManifestModule(index);
      expect(rendered).not.toContain("generatedAt");
    },
    SLOW_MANIFEST_COLLECTION_TIMEOUT,
  );
});
