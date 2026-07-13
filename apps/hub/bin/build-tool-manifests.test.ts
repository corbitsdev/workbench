import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  loadCommittedToolManifestFactories,
  sortFactoryManifests,
} from "@workbench/tool-manifest";
import {
  collectToolFactoryManifests,
  toolManifestIndexPath,
} from "./build-tool-manifests.ts";

describe("build-tool-manifests", () => {
  test("committed index.json matches live package manifests", async () => {
    const live = sortFactoryManifests(await collectToolFactoryManifests());
    const raw = JSON.parse(readFileSync(toolManifestIndexPath(), "utf8")) as {
      factories: unknown;
    };
    const committed = sortFactoryManifests(
      raw.factories as Parameters<typeof sortFactoryManifests>[0],
    );
    expect(live).toEqual(committed);
  });

  test("committed generated module matches live package manifests", async () => {
    const live = sortFactoryManifests(await collectToolFactoryManifests());
    expect(loadCommittedToolManifestFactories()).toEqual(live);
  });
});
