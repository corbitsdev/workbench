// The browser-safe half of the Connections surface: every api-key
// connector this ticket exposes, as one `ConnectorDescriptor` map. This
// is the `./registry` subpath — imported directly by
// `packages/settings-ui`, a browser bundle — so it imports only from
// `./descriptor.ts`, `./probes.ts`, and `@workbench/hub-client`'s own
// light `./credential-test` subpath, never `hono`, `./routes.ts`, or
// `@workbench/hub-client`'s main index (which pulls in `@intx/inference`
// and every workflow package). See `credential-test.ts`'s own header
// comment for why that subpath exists in the first place.
//
// The eight non-OAuth inference providers come straight from
// `PROVIDER_TEST_CONFIG` — the one source of provider metadata,
// re-exported here rather than duplicated. OpenRouter and Hugging Face
// are deliberately excluded: they're OAuth connectors, out of scope for
// this ticket, and the settings-ui renders them as separate hardcoded
// cards pointing at the existing `/api/onboarding/oauth/*` routes.
import {
  PROVIDER_TEST_CONFIG,
  testProviderCredential,
  type SupportedCredentialProvider,
} from "@workbench/hub-client/credential-test";
export type { ConnectorAuthKind, ConnectorDescriptor } from "./descriptor";
import type { ConnectorDescriptor } from "./descriptor";
import {
  testExaCredential,
  testGranolaCredential,
  testLinearCredential,
  testScrapeCreatorsCredential,
} from "./probes";

const INFERENCE_PROVIDER_DOCS_URL: Readonly<
  Record<SupportedCredentialProvider, string>
> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  "google-genai": "https://aistudio.google.com/apikey",
  xai: "https://console.x.ai",
  "opencode-zen": "https://opencode.ai/zen",
  groq: "https://console.groq.com/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  mistral: "https://console.mistral.ai/api-keys",
  // OAuth connectors, excluded from the registry below — docs never read.
  openrouter: "https://openrouter.ai",
  huggingface: "https://huggingface.co/settings/tokens",
};

function inferenceProviderDescriptors(): Record<string, ConnectorDescriptor> {
  const entries: Record<string, ConnectorDescriptor> = {};
  for (const [id, config] of Object.entries(PROVIDER_TEST_CONFIG)) {
    if (id === "openrouter" || id === "huggingface") continue;
    const providerId = id as SupportedCredentialProvider;
    entries[id] = {
      id,
      displayName: config.displayName,
      authKind: "api-key",
      credentialPlugin: "http",
      docsUrl: INFERENCE_PROVIDER_DOCS_URL[providerId],
      feedsTools: [],
      probe: (apiKey) =>
        testProviderCredential({ provider: providerId, apiKey }),
    };
  }
  return entries;
}

export const CONNECTOR_REGISTRY: Readonly<Record<string, ConnectorDescriptor>> =
  {
    ...inferenceProviderDescriptors(),
    granola: {
      id: "granola",
      credentialPlugin: "http",
      displayName: "Granola",
      authKind: "api-key",
      docsUrl: "https://www.granola.ai",
      feedsTools: ["@corbits/granola-tools"],
      probe: (apiKey) => testGranolaCredential(apiKey),
    },
    exa: {
      id: "exa",
      credentialPlugin: "http",
      displayName: "Exa",
      authKind: "api-key",
      docsUrl: "https://exa.ai",
      feedsTools: ["@corbits/web-search-tools"],
      probe: (apiKey) => testExaCredential(apiKey),
    },
    scrapecreators: {
      id: "scrapecreators",
      credentialPlugin: "http",
      displayName: "ScrapeCreators",
      authKind: "api-key",
      docsUrl: "https://scrapecreators.com",
      feedsTools: ["@corbits/reddit-tools"],
      probe: (apiKey) => testScrapeCreatorsCredential(apiKey),
    },
    linear: {
      id: "linear",
      credentialPlugin: "http-raw-authorization",
      displayName: "Linear",
      authKind: "api-key",
      docsUrl: "https://linear.app/settings/api",
      feedsTools: ["@corbits/linear-tools"],
      probe: (apiKey) => testLinearCredential(apiKey),
    },
  };

export function connectorDescriptors(): readonly ConnectorDescriptor[] {
  return Object.values(CONNECTOR_REGISTRY);
}
