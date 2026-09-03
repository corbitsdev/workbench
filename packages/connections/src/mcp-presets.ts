// The `McpPreset` shape and the generic helpers a caller needs to work
// with a preset list — the concrete curated presets themselves (Granola,
// Exa, Linear, GitHub MCP, ...) moved to `templates/connectors.ts` as
// part of CL-7384, alongside `./registry.ts`'s connector descriptors.
export type McpPresetConnectionMode = "oauth" | "keyless" | "token";

export type McpPreset = {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly url: string;
  readonly connectionMode: McpPresetConnectionMode;
  readonly docsUrl: string;
  readonly icon?: { readonly path: string; readonly hex: string };
  readonly nativeConnectorId?: string;
  /** Token presets only: the numbered walkthrough the connect card
   * renders above the paste field — each step one action a person can
   * take, ending with what happens to the token. */
  readonly tokenSteps?: readonly string[];
  /** Space-joined into RFC 7591 DCR `clientMetadata.scope` when this
   * preset's OAuth connect runs. Omit the key — other presets stay on
   * the SDK's SEP-835 PRM fallback. */
  readonly oauthScopes?: readonly string[];
};

export function mcpPresetConnectorIds(
  presets: readonly McpPreset[],
): readonly string[] {
  return presets.flatMap((preset) =>
    preset.nativeConnectorId === undefined ? [] : [preset.nativeConnectorId],
  );
}

export function mcpPresetBySlug(
  presets: readonly McpPreset[],
  slug: string,
): McpPreset | undefined {
  return presets.find((preset) => preset.slug === slug);
}

export function mcpPresetByName(
  presets: readonly McpPreset[],
  name: string,
): McpPreset | undefined {
  const needle = name.trim().toLowerCase();
  return presets.find(
    (preset) =>
      preset.slug === needle || preset.displayName.toLowerCase() === needle,
  );
}
