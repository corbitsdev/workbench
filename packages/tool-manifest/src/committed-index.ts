import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sortFactoryManifests } from "./derive";
import { parseToolManifestIndex, type ToolFactoryManifest } from "./schema";

export function monorepoRootFromToolManifestPackage(): string {
  return join(import.meta.dir, "..", "..", "..");
}

export function committedToolManifestIndexPath(): string {
  return join(
    monorepoRootFromToolManifestPackage(),
    "apps/hub/generated/tool-manifests/index.json",
  );
}

let cachedFactories: ToolFactoryManifest[] | null = null;

export function loadCommittedToolManifestFactories(): ToolFactoryManifest[] {
  if (cachedFactories !== null) return cachedFactories;
  const raw = JSON.parse(
    readFileSync(committedToolManifestIndexPath(), "utf8"),
  ) as unknown;
  const parsed = parseToolManifestIndex(raw);
  if (typeof parsed === "string") {
    throw new Error(
      `Invalid committed tool manifest index at ${committedToolManifestIndexPath()}: ${parsed}`,
    );
  }
  cachedFactories = sortFactoryManifests(parsed.factories);
  return cachedFactories;
}

export function clearCommittedToolManifestCache(): void {
  cachedFactories = null;
}
