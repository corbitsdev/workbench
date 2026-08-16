// Presentation-only sidecar lookups keyed by connector id — the same
// convention `@corbits/settings-ui`'s `INFERENCE_PROVIDER_DOCS_URL` and
// `CONNECTOR_PINNED_WORKFLOWS` already use rather than growing
// `ConnectorDescriptor` itself with UI-only fields. `CONNECTOR_REGISTRY`
// knows nothing about icons, categories, or outcome copy — this module is
// where the gallery's opinions about those live.

import {
  Cpu,
  GitBranch,
  GitPullRequest,
  Mic,
  Search,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";

export type PluginCategory =
  | "Inference"
  | "Productivity"
  | "Data & research"
  | "Dev tools";

export const PLUGIN_CATEGORY_ORDER: readonly PluginCategory[] = [
  "Productivity",
  "Dev tools",
  "Data & research",
  "Inference",
];

const CATEGORY_BY_ID: Readonly<Record<string, PluginCategory>> = {
  anthropic: "Inference",
  openai: "Inference",
  "google-genai": "Inference",
  xai: "Inference",
  "opencode-zen": "Inference",
  groq: "Inference",
  deepseek: "Inference",
  mistral: "Inference",
  openrouter: "Inference",
  huggingface: "Inference",
  granola: "Productivity",
  exa: "Data & research",
  scrapecreators: "Data & research",
  linear: "Dev tools",
  github: "Dev tools",
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
  openrouter: "Routes your agents' inference through OpenRouter's model catalog.",
  huggingface: "Routes your agents' inference through Hugging Face-hosted models.",
  granola: "Lets agents read your Granola call notes and post-call summaries.",
  exa: "Lets agents run live web search and research lookups.",
  scrapecreators: "Lets agents pull Reddit threads and creator content.",
  linear: "Lets agents read and update your Linear issues.",
  github: "Lets agents read and open pull requests in your GitHub repos.",
};

// No brand mark for GitHub or Linear ships in lucide-react — `GitPullRequest`
// and `GitBranch` read as their nearest honest generic equivalents rather
// than reaching for a third-party brand icon set.
const ICON_BY_ID: Readonly<Record<string, LucideIcon>> = {
  granola: Mic,
  exa: Search,
  scrapecreators: MessageSquare,
  linear: GitBranch,
  github: GitPullRequest,
};

/** The handful surfaced under "Featured", ahead of the category grid — a
 * short, owner-editable literal list, not a derived ranking. */
export const FEATURED_CONNECTOR_IDS: readonly string[] = [
  "granola",
  "github",
  "linear",
  "openrouter",
  "huggingface",
  "exa",
];

export function pluginCategory(connectorId: string): PluginCategory {
  return CATEGORY_BY_ID[connectorId] ?? "Inference";
}

export function pluginOutcome(connectorId: string, displayName: string): string {
  return OUTCOME_BY_ID[connectorId] ?? `Connects ${displayName} to your agents.`;
}

/** Every connector renders an icon glyph — the eight inference providers
 * and the two OAuth connectors that don't have a distinct product mark of
 * their own share `Cpu`, since "inference provider" is the honest shape of
 * what they all are here. */
export function pluginIcon(connectorId: string): LucideIcon {
  return ICON_BY_ID[connectorId] ?? Cpu;
}
