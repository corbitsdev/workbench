// Presentation-only sidecar lookups keyed by connector id — the same
// convention `@corbits/settings-ui`'s `INFERENCE_PROVIDER_DOCS_URL` and
// `CONNECTOR_PINNED_WORKFLOWS` already use rather than growing
// `ConnectorDescriptor` itself with UI-only fields. `CONNECTOR_REGISTRY`
// knows nothing about icons, categories, or outcome copy — this module is
// where the gallery's opinions about those live.

import {
  ChatCircle,
  Cpu,
  GitBranch,
  GitPullRequest,
  type Icon,
  MagnifyingGlass,
  Microphone,
  Stack,
} from "@corbits/icons";

export type PluginCategory =
  | "Communication"
  | "Productivity"
  | "Sales & customer"
  | "Engineering"
  | "Research & data";

export const PLUGIN_CATEGORY_ORDER: readonly PluginCategory[] = [
  "Communication",
  "Productivity",
  "Sales & customer",
  "Engineering",
  "Research & data",
];

const CATEGORY_BY_ID: Readonly<Partial<Record<string, PluginCategory>>> = {
  granola: "Productivity",
  manus: "Productivity",
  notion: "Productivity",
  zoom: "Communication",
  slack: "Communication",
  google: "Productivity",
  canva: "Productivity",
  attio: "Sales & customer",
  hubspot: "Sales & customer",
  exa: "Research & data",
  scrapecreators: "Research & data",
  sumble: "Research & data",
  linear: "Engineering",
  github: "Engineering",
  "github-mcp": "Engineering",
  sentry: "Engineering",
  vercel: "Engineering",
  render: "Engineering",
  railway: "Engineering",
  posthog: "Engineering",
  browserbase: "Engineering",
};

/** One honest sentence: what connecting this plugin actually lets an agent
 * do. No metrics, no hype — the same rule `WorkflowCatalogEntry.whatItDoes`
 * follows. */
const OUTCOME_BY_ID: Readonly<Record<string, string>> = {
  anthropic: "Powers your agents' Claude-based inference.",
  openai: "Powers your agents' OpenAI-based inference.",
  "google-genai": "Powers your agents' Gemini-based inference.",
  xai: "Powers your agents' Grok-based inference.",
  "opencode-zen": "Powers your agents' Opencode Zen inference.",
  groq: "Powers your agents' fast Groq-hosted inference.",
  deepseek: "Powers your agents' DeepSeek-based inference.",
  mistral: "Powers your agents' Mistral-based inference.",
  openrouter:
    "Routes your agents' inference through OpenRouter's model catalog.",
  huggingface:
    "Routes your agents' inference through Hugging Face-hosted models.",
  granola: "Lets agents read your Granola call notes and post-call summaries.",
  manus:
    "Lets agents run Manus tasks and retrieve files — including slide decks.",
  exa: "Lets agents run live web search and research lookups.",
  scrapecreators: "Lets agents pull Reddit threads and creator content.",
  linear: "Lets agents read and update your Linear issues.",
  github: "Lets agents read and open pull requests in your GitHub repos.",
};

// No brand mark for GitHub or Linear ships in @corbits/icons — `GitPullRequest`
// and `GitBranch` read as their nearest honest generic equivalents rather
// than reaching for a third-party brand icon set.
const ICON_BY_ID: Readonly<Record<string, Icon>> = {
  granola: Microphone,
  manus: Stack,
  exa: MagnifyingGlass,
  scrapecreators: ChatCircle,
  linear: GitBranch,
  github: GitPullRequest,
};

export function pluginCategory(catalogId: string): PluginCategory | undefined {
  return CATEGORY_BY_ID[catalogId];
}

export function pluginOutcome(
  connectorId: string,
  displayName: string,
): string {
  return (
    OUTCOME_BY_ID[connectorId] ?? `Connects ${displayName} to your agents.`
  );
}

/** Every connector renders an icon glyph — the eight inference providers
 * and the two OAuth connectors that don't have a distinct product mark of
 * their own share `Cpu`, since "inference provider" is the honest shape of
 * what they all are here. */
export function pluginIcon(connectorId: string): Icon {
  return ICON_BY_ID[connectorId] ?? Cpu;
}
