// This tool bundle carries no connector set of its own — the deploying
// build wires its own registry/preset list into `WorkflowConnectionEnv`
// (e.g. Workbench's `@corbits/connections` `CONNECTOR_REGISTRY` and
// `MCP_PRESETS`). All this tool needs from either shape is the handful
// of fields it actually reads (`id`/`displayName` off a descriptor,
// `slug`/`displayName`/`description` off a preset) plus the one lookup
// helper — so those live here instead of a runtime dependency on
// `@corbits/connections`, which this publishable package cannot carry
// (it is a private, hub-only library). A caller's richer descriptor/
// preset objects satisfy these structurally; nothing here needs to
// change when that caller adds fields of its own.

export interface ConnectorDescriptor {
  readonly id: string;
  readonly displayName: string;
}

export type ConnectorRegistry = Readonly<Record<string, ConnectorDescriptor>>;

export interface McpPreset {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
}

export function mcpPresetByName(
  presets: readonly McpPreset[],
  name: string,
): McpPreset | undefined {
  const needle = name.trim().toLowerCase();
  return presets.find(
    (preset) => preset.slug === needle || preset.displayName.toLowerCase() === needle,
  );
}
