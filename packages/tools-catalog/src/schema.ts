import { type } from "arktype";

/**
 * A single tool a catalog entry advertises. `name` is the LLM-facing tool
 * name exactly as it appears in the agent's resolved tool definitions (the
 * `toLlmToolName` form, e.g. `attio__query_records`) so the director and the
 * `load_tools` handler can match it against the live definition set without
 * any further transformation.
 */
export const ToolCatalogToolSchema = type({
  name: "string > 0",
  description: "string",
});
export type ToolCatalogTool = typeof ToolCatalogToolSchema.infer;

/**
 * One catalog-only tool package. Assembled cheaply (no tool factories, no
 * credentials) so the catalog can be built at definition time and shipped to
 * the sidecar director + catalog tools verbatim.
 */
export const ToolCatalogEntrySchema = type({
  package: "string > 0",
  summary: "string",
  tags: "string[]",
  tools: ToolCatalogToolSchema.array(),
});
export type ToolCatalogEntry = typeof ToolCatalogEntrySchema.infer;

export const ToolCatalogSchema = ToolCatalogEntrySchema.array();
export type ToolCatalog = typeof ToolCatalogSchema.infer;

/**
 * Mutable, in-process exposure state shared between the catalog tools and the
 * dynamic-tools director within a single sidecar harness. `load_tools` adds
 * names here; the director reads it on every inference call to decide what to
 * advertise. Sticky for the session — names are never removed.
 */
export type ToolExposureState = {
  readonly exposed: Set<string>;
};

/**
 * Env key under which the harness hands the director its catalog + exposure
 * state. The catalog tools receive the same objects by direct construction;
 * the director can only reach them through `env`, so this is the seam.
 */
export const DYNAMIC_TOOLS_ENV_KEY = "@workbench/tools-catalog/dynamic";

export type DynamicToolsEnv = {
  readonly catalog: ToolCatalog;
  readonly exposure: ToolExposureState;
};
