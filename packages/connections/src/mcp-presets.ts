import {
  siGithub,
  siNotion,
  siPosthog,
  siRailway,
  siSentry,
} from "simple-icons";

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

/**
 * Curated remote MCP servers that Workbench can connect without asking a
 * person for a URL, API key, client id, or client secret. OAuth entries have
 * been verified to advertise OAuth discovery, PKCE, and dynamic client
 * registration; keyless entries can be probed and stored immediately; token
 * entries accept a pasted access token as the bearer (GitHub's MCP server
 * does OAuth only for clients pre-registered with GitHub — it offers no
 * dynamic client registration — so its connect here is the token walk).
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
    // Deliberately NOT slug "github" and NOT nativeConnectorId "github":
    // the native GitHub connector (PAT/OAuth-App feeding
    // @corbits/github-tools) stays its own card, and preset lookups by
    // "github" must keep resolving to it, never here.
    slug: "github-mcp",
    displayName: "GitHub MCP",
    description: "Search code, work with issues and pull requests.",
    url: "https://api.githubcopilot.com/mcp/",
    connectionMode: "token",
    docsUrl: "https://github.com/settings/tokens",
    icon: { path: siGithub.path, hex: siGithub.hex },
    tokenSteps: [
      "Open github.com/settings/tokens and generate a new token.",
      "Give it the repo scope — that lets agents read code, issues, and pull requests.",
      "Paste it below. It's stored encrypted, only your agents use it, and you can disconnect any time.",
    ],
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
  {
    // No simple-icons listing for Canva (CL-6647) — same gap as Granola
    // and Sumble above, so this card falls back to the initial-letter
    // tile rather than risk a hand-traced or doctored mark.
    slug: "canva",
    displayName: "Canva",
    description: "Design decks, docs, and graphics.",
    url: "https://mcp.canva.com/mcp",
    connectionMode: "oauth",
    docsUrl: "https://www.canva.dev/docs/mcp/",
    oauthScopes: [
      "profile:read",
      "design:meta:read",
      "design:content:write",
      "design:content:read",
      "folder:read",
      "folder:write",
      "brandtemplate:content:read",
      "brandtemplate:meta:read",
      "brandtemplate:content:write",
      "comment:write",
      "comment:read",
      "asset:read",
      "asset:write",
      "brandkit:read",
      "help:answers:read",
      "help:answers:write",
    ],
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
