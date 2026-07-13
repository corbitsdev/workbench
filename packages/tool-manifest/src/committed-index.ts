import { sortFactoryManifests } from "./derive";
import { COMMITTED_TOOL_MANIFEST_INDEX } from "./generated/tool-manifest-index";
import { parseToolManifestIndex, type ToolFactoryManifest } from "./schema";

// The committed index is a generated static module (not a readFileSync of
// index.json) so this package stays free of node builtins — the web app
// reaches it through @workbench/agents and @workbench/shared, and Vite shims
// node:fs/node:path to empty modules in a browser bundle.

let cachedFactories: ToolFactoryManifest[] | null = null;

export function loadCommittedToolManifestFactories(): ToolFactoryManifest[] {
  if (cachedFactories !== null) return cachedFactories;
  const parsed = parseToolManifestIndex(COMMITTED_TOOL_MANIFEST_INDEX);
  if (typeof parsed === "string") {
    throw new Error(
      `Invalid committed tool manifest index (packages/tool-manifest/src/generated/tool-manifest-index.ts): ${parsed}`,
    );
  }
  cachedFactories = sortFactoryManifests(parsed.factories);
  return cachedFactories;
}

export function clearCommittedToolManifestCache(): void {
  cachedFactories = null;
}
