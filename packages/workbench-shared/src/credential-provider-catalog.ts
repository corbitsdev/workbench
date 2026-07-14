import {
  deriveToolCredentialCatalogEntries,
  loadCommittedToolManifestFactories,
} from "@workbench/tool-manifest";

export interface CredentialProviderCatalogEntry {
  providerName: string;
  providerPlugin: string;
  label: string;
  kind: "inference" | "tool";
  defaultMetadata?: Record<string, unknown>;
  secretLabel?: string;
  secondaryField?: { label: string; placeholder: string; required?: boolean };
  platforms?: readonly string[];
  briefSource?: {
    description: string;
    defaultEnabled?: boolean;
    tool?: string;
  };
  /** Inbox-specific copy for the member Settings → Inbox surface (CL-3577).
   * Falls back to `briefSource.description` when absent — most sources read
   * fine with brief-oriented copy, but a source whose inbox behavior reads
   * differently from its brief behavior (e.g. "syncs into your tasks" vs
   * "in your next brief") should set this explicitly. */
  inboxSource?: {
    description: string;
  };
}

export const BIFROST_PROVIDER_NAME = "corbits-default-bifrost" as const;

const INFERENCE_CREDENTIAL_PROVIDER_ENTRIES: CredentialProviderCatalogEntry[] =
  [
    {
      providerName: "openai-compatible",
      providerPlugin: "openai-compatible",
      label: "OpenAI-compatible LLM",
      kind: "inference",
      defaultMetadata: { baseURL: "https://api.openai.com/v1" },
    },
    {
      providerName: BIFROST_PROVIDER_NAME,
      providerPlugin: "openai-compatible",
      label: "Bifrost (/v1)",
      kind: "inference",
      secondaryField: {
        label: "Base URL",
        placeholder: "https://corbits-ai-gateway.up.railway.app/v1",
        required: true,
      },
    },
    {
      providerName: "corbits-default-bifrost-anthropic",
      providerPlugin: "anthropic",
      label: "Bifrost (/anthropic)",
      kind: "inference",
      secondaryField: {
        label: "Base URL",
        placeholder: "https://corbits-ai-gateway.up.railway.app/anthropic",
        required: true,
      },
    },
    {
      providerName: "corbits-default-bifrost-genai",
      providerPlugin: "google-genai",
      label: "Bifrost (/genai)",
      kind: "inference",
      secondaryField: {
        label: "Base URL",
        placeholder: "https://corbits-ai-gateway.up.railway.app/genai",
        required: true,
      },
    },
    {
      providerName: "anthropic",
      providerPlugin: "anthropic",
      label: "Anthropic",
      kind: "inference",
      defaultMetadata: { baseURL: "https://api.anthropic.com" },
    },
    {
      providerName: "xai",
      providerPlugin: "xai",
      label: "xAI",
      kind: "inference",
    },
  ];

const TOOL_OAUTH_APP_CREDENTIAL_ENTRIES: CredentialProviderCatalogEntry[] = [
  {
    providerName: "linear-oauth-app",
    providerPlugin: "linear",
    label: "Linear OAuth app",
    kind: "tool",
    secretLabel: "Client secret",
    secondaryField: {
      label: "Client ID",
      placeholder: "OAuth application client ID",
      required: true,
    },
  },
  {
    providerName: "attio-oauth-app",
    providerPlugin: "attio",
    label: "Attio OAuth app",
    kind: "tool",
    secretLabel: "Client secret",
    secondaryField: {
      label: "Client ID",
      placeholder: "OAuth application client ID",
      required: true,
    },
  },
];

/** Owner UI fields not yet modeled on per-package tool manifests. */
const TOOL_CREDENTIAL_SUPPLEMENTS: Record<
  string,
  Pick<
    CredentialProviderCatalogEntry,
    "defaultMetadata" | "briefSource" | "inboxSource"
  >
> = {
  granola: {
    defaultMetadata: { baseURL: "https://public-api.granola.ai/v1" },
    briefSource: {
      description: "Call notes from meetings since your last brief.",
      tool: "granola_list_notes",
    },
    inboxSource: {
      description:
        "New Granola calls are classified and summarized; participants get the summary and their action items by mail.",
    },
  },
  firecrawl: {
    defaultMetadata: { baseURL: "https://api.firecrawl.dev/v2" },
  },
  linear: {
    defaultMetadata: { baseURL: "https://api.linear.app/graphql" },
    briefSource: {
      description: "Issues updated since your last brief.",
      tool: "linear_list_issues",
    },
    inboxSource: {
      description: "New Linear activity assigned to you lands in your inbox.",
    },
  },
  attio: {
    defaultMetadata: { baseURL: "https://api.attio.com" },
    briefSource: {
      description: "New CRM records and open tasks since your last brief.",
      tool: "attio_recent_activity",
    },
    inboxSource: {
      description:
        "Your Attio tasks sync into Workbench tasks — created, updated, and completed in step.",
    },
  },
  vercel: {
    defaultMetadata: { baseURL: "https://api.vercel.com" },
    briefSource: {
      description: "Deployments since your last brief, with build state.",
      tool: "vercel_list_deployments",
    },
  },
  sumble: {
    defaultMetadata: { baseURL: "https://api.sumble.com" },
  },
  slack: {
    defaultMetadata: { baseURL: "https://slack.com/api" },
    inboxSource: {
      description: "Slack mentions of you land in your inbox.",
    },
  },
};

function buildDerivedToolCredentialCatalogEntries(): CredentialProviderCatalogEntry[] {
  const derived = deriveToolCredentialCatalogEntries(
    loadCommittedToolManifestFactories(),
  );
  return derived.map((entry) => {
    const supplement = TOOL_CREDENTIAL_SUPPLEMENTS[entry.providerName];
    return {
      providerName: entry.providerName,
      providerPlugin: entry.providerName,
      label: entry.label,
      kind: "tool",
      ...(entry.secretLabel !== undefined
        ? { secretLabel: entry.secretLabel }
        : {}),
      ...(entry.secondaryField !== undefined
        ? { secondaryField: entry.secondaryField }
        : {}),
      ...(entry.platforms !== undefined ? { platforms: entry.platforms } : {}),
      ...(supplement?.defaultMetadata !== undefined
        ? { defaultMetadata: supplement.defaultMetadata }
        : {}),
      ...(supplement?.briefSource !== undefined
        ? { briefSource: supplement.briefSource }
        : {}),
      ...(supplement?.inboxSource !== undefined
        ? { inboxSource: supplement.inboxSource }
        : {}),
    };
  });
}

export const CREDENTIAL_PROVIDER_CATALOG: readonly CredentialProviderCatalogEntry[] =
  [
    ...INFERENCE_CREDENTIAL_PROVIDER_ENTRIES,
    ...buildDerivedToolCredentialCatalogEntries(),
    ...TOOL_OAUTH_APP_CREDENTIAL_ENTRIES,
  ];
