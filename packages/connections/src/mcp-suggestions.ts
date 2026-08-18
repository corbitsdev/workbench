// CL-6256's roster, the honest half: every name the owner asked for that
// has neither a known-good endpoint already proven in this codebase
// (Granola) nor an owner-supplied one (ScrapeCreators, Sumble — see
// `./mcp-presets.ts`). Without network access to verify each service's MCP
// endpoint from here, a dead "Connect" button pointed at a guessed URL
// would be worse than no button at all — so every one of these ships only
// as a directory suggestion: a name and, where `simple-icons` has the
// brand, its mark, whose one action opens the "Add MCP server" dialog
// prefilled with the name and an empty URL for whoever has (or finds) the
// real endpoint to paste in. This is a suggestion, not a connection — it
// carries no `url`, no `slug`, nothing `mcp-server-routes.ts` could ever
// store on its own; the row it renders as shares the same store/row shape
// as a curated preset or a hand-added server only once someone completes
// that dialog and the probe succeeds.
import {
  siGoogle,
  siHubspot,
  siNotion,
  siPosthog,
  siRailway,
  siRender,
  siSentry,
  siVercel,
  siZoom,
} from "simple-icons";

export type McpSuggestion = {
  readonly slug: string;
  readonly displayName: string;
  readonly icon?: { readonly path: string; readonly hex: string };
};

// Attio, Browserbase, and Slack have no `simple-icons` listing as of this
// package's pinned version — those three fall back to the same monochrome
// initial tile every iconless registry/preset entry already renders.
export const MCP_SUGGESTIONS: readonly McpSuggestion[] = [
  {
    slug: "notion",
    displayName: "Notion",
    icon: { path: siNotion.path, hex: siNotion.hex },
  },
  { slug: "slack", displayName: "Slack" },
  {
    slug: "sentry",
    displayName: "Sentry",
    icon: { path: siSentry.path, hex: siSentry.hex },
  },
  {
    slug: "vercel",
    displayName: "Vercel",
    icon: { path: siVercel.path, hex: siVercel.hex },
  },
  {
    slug: "render",
    displayName: "Render",
    icon: { path: siRender.path, hex: siRender.hex },
  },
  {
    slug: "railway",
    displayName: "Railway",
    icon: { path: siRailway.path, hex: siRailway.hex },
  },
  { slug: "attio", displayName: "Attio" },
  {
    slug: "hubspot",
    displayName: "HubSpot",
    icon: { path: siHubspot.path, hex: siHubspot.hex },
  },
  {
    slug: "zoom",
    displayName: "Zoom",
    icon: { path: siZoom.path, hex: siZoom.hex },
  },
  {
    slug: "posthog",
    displayName: "PostHog",
    icon: { path: siPosthog.path, hex: siPosthog.hex },
  },
  { slug: "browserbase", displayName: "Browserbase" },
  {
    slug: "google",
    displayName: "Google",
    icon: { path: siGoogle.path, hex: siGoogle.hex },
  },
];

export function mcpSuggestionBySlug(slug: string): McpSuggestion | undefined {
  return MCP_SUGGESTIONS.find((suggestion) => suggestion.slug === slug);
}
