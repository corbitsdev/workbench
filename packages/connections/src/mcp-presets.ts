import { siNotion, siPosthog, siRailway, siSentry } from "simple-icons";

export type McpPresetConnectionMode = "oauth" | "keyless";

export type McpPreset = {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly url: string;
  readonly connectionMode: McpPresetConnectionMode;
  readonly docsUrl: string;
  readonly icon?: { readonly path: string; readonly hex: string };
  readonly nativeConnectorId?: string;
};

/**
 * Curated remote MCP servers that Workbench can connect without asking a
 * person for a URL, API key, client id, or client secret. OAuth entries have
 * been verified to advertise OAuth discovery, PKCE, and dynamic client
 * registration; keyless entries can be probed and stored immediately.
 */
export const MCP_PRESETS: readonly McpPreset[] = [
  {
    slug: "granola",
    displayName: "Granola",
    description: "Search meeting notes, transcripts, and action items.",
    url: "https://mcp.granola.ai/mcp",
    connectionMode: "oauth",
    docsUrl: "https://docs.granola.ai/help-center/sharing/integrations/mcp",
    nativeConnectorId: "granola",
  },
  {
    slug: "exa",
    displayName: "Exa",
    description: "Search and research the live web.",
    url: "https://mcp.exa.ai/mcp",
    connectionMode: "keyless",
    docsUrl: "https://docs.exa.ai/reference/exa-mcp",
    nativeConnectorId: "exa",
  },
  {
    slug: "linear",
    displayName: "Linear",
    description: "Read and update issues, projects, and comments.",
    url: "https://mcp.linear.app/mcp",
    connectionMode: "oauth",
    docsUrl: "https://linear.app/docs/mcp",
    nativeConnectorId: "linear",
  },
  {
    slug: "notion",
    displayName: "Notion",
    description: "Search and update pages, databases, and workspace content.",
    url: "https://mcp.notion.com/mcp",
    connectionMode: "oauth",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    icon: { path: siNotion.path, hex: siNotion.hex },
  },
  {
    slug: "sentry",
    displayName: "Sentry",
    description: "Investigate errors, traces, releases, and projects.",
    url: "https://mcp.sentry.dev/mcp",
    connectionMode: "oauth",
    docsUrl: "https://mcp.sentry.dev/",
    icon: { path: siSentry.path, hex: siSentry.hex },
  },
  {
    slug: "attio",
    displayName: "Attio",
    description: "Work with CRM records, lists, notes, and tasks.",
    url: "https://mcp.attio.com/mcp",
    connectionMode: "oauth",
    docsUrl: "https://docs.attio.com/mcp/overview",
  },
  {
    slug: "railway",
    displayName: "Railway",
    description: "Inspect and manage projects, services, and deployments.",
    url: "https://mcp.railway.com",
    connectionMode: "oauth",
    docsUrl: "https://docs.railway.com/ai/mcp-server",
    icon: { path: siRailway.path, hex: siRailway.hex },
  },
  {
    slug: "posthog",
    displayName: "PostHog",
    description: "Explore product analytics, errors, flags, and experiments.",
    url: "https://mcp.posthog.com/mcp",
    connectionMode: "oauth",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    icon: { path: siPosthog.path, hex: siPosthog.hex },
  },
  {
    slug: "sumble",
    displayName: "Sumble",
    description: "Research accounts, people, technologies, and buying signals.",
    url: "https://mcp.sumble.com/",
    connectionMode: "oauth",
    docsUrl: "https://sumble.com/guides/account-research",
  },
];

export const MCP_PRESET_CONNECTOR_IDS: readonly string[] = MCP_PRESETS.flatMap(
  (preset) =>
    preset.nativeConnectorId === undefined ? [] : [preset.nativeConnectorId],
);

export function mcpPresetBySlug(slug: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.slug === slug);
}

export function mcpPresetByName(name: string): McpPreset | undefined {
  const needle = name.trim().toLowerCase();
  return MCP_PRESETS.find(
    (preset) =>
      preset.slug === needle || preset.displayName.toLowerCase() === needle,
  );
}
