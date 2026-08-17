// Curated, well-known MCP servers (CL-6152): the owner's steer was "we
// should be making tools MCP-based where possible" — Granola, Exa, and
// Linear all publish a real Streamable HTTP MCP endpoint, so Settings ›
// Connections and Plugins offer each as a one-click preset card (URL
// prefilled, name fixed) rather than making a person paste the URL into
// the generic "Add MCP server" form themselves. Connecting a preset still
// goes through the exact same `mcp-server-routes.ts` probe-then-store
// path as a hand-typed server — a preset is only a shortcut to that
// path's `name`/`url` inputs, never a second storage mechanism.
//
// `keyOptional` drives the connect form's copy, not its validation: Exa's
// MCP server answers unauthenticated requests (the owner's own steer —
// "Exa MCP doesn't require an API key, it's optional"), so its card reads
// "no key needed" and the token field is skippable; Granola's and
// Linear's servers require a session either via an API token or OAuth
// (`mcp-oauth-routes.ts`), so their cards always show the field or the
// "Connect with OAuth" action.
//
// `nativeToolPackage` names the existing api-key connector
// (`./registry.ts`) that keeps working unchanged when a tenant already
// holds that credential — CL-6152 doesn't retire `granola-tools`,
// `web-search-tools`, or `linear-tools`; it only changes which surface a
// person clicks first. `settings-ui`/`plugins-ui` read this list to
// suppress the now-redundant static card for the same service (see
// `MCP_PRESET_CONNECTOR_IDS`), so a tenant is never shown two cards for
// one service.
export type McpPreset = {
  readonly slug: string;
  readonly displayName: string;
  /** One honest sentence, no "MCP" jargon beyond the trailing hint —
   * `plugins-ui`/`settings-ui` render this as the card body. */
  readonly description: string;
  readonly url: string;
  readonly keyOptional: boolean;
  readonly docsUrl: string;
  /** The `CONNECTOR_REGISTRY` id this preset supersedes as the featured
   * card for the same service, or `undefined` when there is no static
   * api-key connector to fold in behind it. */
  readonly nativeConnectorId?: string;
};

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    slug: "granola",
    displayName: "Granola",
    description: "Pull your Granola meeting notes and transcripts — via MCP.",
    url: "https://mcp.granola.ai/mcp",
    keyOptional: false,
    docsUrl: "https://www.granola.ai",
    nativeConnectorId: "granola",
  },
  {
    slug: "exa",
    displayName: "Exa",
    description: "Search the web (Exa) — no key needed.",
    url: "https://mcp.exa.ai/mcp",
    keyOptional: true,
    docsUrl: "https://exa.ai",
    nativeConnectorId: "exa",
  },
  {
    slug: "linear",
    displayName: "Linear",
    description: "Manage Linear issues and projects — via MCP.",
    url: "https://mcp.linear.app/mcp",
    keyOptional: false,
    docsUrl: "https://linear.app",
    nativeConnectorId: "linear",
  },
];

/** Every `CONNECTOR_REGISTRY` id a curated preset now fronts — the set
 * `settings-ui`/`plugins-ui` filter out of their static connector grids so
 * a service never renders both its old api-key card and its new MCP
 * preset card side by side. */
export const MCP_PRESET_CONNECTOR_IDS: readonly string[] = MCP_PRESETS.filter(
  (preset) => preset.nativeConnectorId !== undefined,
).map((preset) => preset.nativeConnectorId as string);

export function mcpPresetBySlug(slug: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.slug === slug);
}

/** Case-insensitive lookup by the service's own name — what
 * `@corbits/connections-tools`' `request_connection` matches a human's
 * "connect Exa" against, alongside the fixed `CONNECTOR_REGISTRY` ids it
 * already checks. */
export function mcpPresetByName(name: string): McpPreset | undefined {
  const needle = name.trim().toLowerCase();
  return MCP_PRESETS.find(
    (preset) =>
      preset.slug === needle || preset.displayName.toLowerCase() === needle,
  );
}
