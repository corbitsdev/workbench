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
// are the two OAuth inference providers, wired below through the same
// `oauth` config shape `./oauth-routes.ts` reads — CL-6028's OAuth route
// factory folded their previously hand-written `packages/onboarding`
// routes into this registry.
import {
  PROVIDER_TEST_CONFIG,
  testProviderCredential,
  type SupportedCredentialProvider,
} from "@workbench/hub-client/credential-test";
export type {
  ConnectorAuthKind,
  ConnectorDescriptor,
  ConnectorOAuthConfig,
  OAuthExchangeResult,
} from "./descriptor";
import type { ConnectorDescriptor } from "./descriptor";
import {
  exchangeCodeForToken,
  HUGGINGFACE_AUTHORIZE_URL,
  HUGGINGFACE_SCOPE,
} from "./huggingface-connect";
import { exchangeCodeForKey, OPENROUTER_AUTH_URL } from "./openrouter-connect";
import {
  testExaCredential,
  testGitHubCredential,
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
  entries["openrouter"] = {
    id: "openrouter",
    displayName: PROVIDER_TEST_CONFIG.openrouter.displayName,
    authKind: "oauth-pkce",
    credentialPlugin: "http",
    docsUrl: INFERENCE_PROVIDER_DOCS_URL.openrouter,
    feedsTools: [],
    oauth: {
      authorizeUrl: OPENROUTER_AUTH_URL,
      usesPKCE: true,
      // OpenRouter round-trips its state purely via the connect cookie;
      // it never echoes `state` back as a callback query param.
      echoesState: false,
      deploysDefaultWorkflows: true,
      buildAuthorizeUrl: ({ callbackUrl, codeChallenge }) => {
        const url = new URL(OPENROUTER_AUTH_URL);
        url.searchParams.set("callback_url", callbackUrl);
        if (codeChallenge !== undefined) {
          url.searchParams.set("code_challenge", codeChallenge);
        }
        url.searchParams.set("code_challenge_method", "S256");
        return url;
      },
      exchange: async ({ code, codeVerifier }) => {
        const result = await exchangeCodeForKey({
          code,
          codeVerifier: codeVerifier ?? "",
        });
        return result.ok ? { ok: true, apiKey: result.key } : result;
      },
    },
  };
  entries["huggingface"] = {
    id: "huggingface",
    displayName: PROVIDER_TEST_CONFIG.huggingface.displayName,
    authKind: "oauth-pkce",
    credentialPlugin: "http",
    docsUrl: INFERENCE_PROVIDER_DOCS_URL.huggingface,
    feedsTools: [],
    oauth: {
      authorizeUrl: HUGGINGFACE_AUTHORIZE_URL,
      usesPKCE: true,
      // HF echoes `state` back in the callback query — the belt-and-
      // suspenders check `oauth-routes.ts` runs before consulting the
      // state store at all.
      echoesState: true,
      deploysDefaultWorkflows: true,
      // No client secret (a public app); the flow is disabled with a
      // `not_configured` outcome when this key is absent from the env
      // bag rather than round-tripping a doomed request.
      clientId: (env) => env["huggingfaceClientId"],
      buildAuthorizeUrl: ({ callbackUrl, state, codeChallenge, clientId }) => {
        const url = new URL(HUGGINGFACE_AUTHORIZE_URL);
        if (clientId !== undefined) url.searchParams.set("client_id", clientId);
        url.searchParams.set("redirect_uri", callbackUrl);
        url.searchParams.set("scope", HUGGINGFACE_SCOPE);
        url.searchParams.set("state", state);
        if (codeChallenge !== undefined) {
          url.searchParams.set("code_challenge", codeChallenge);
        }
        url.searchParams.set("code_challenge_method", "S256");
        return url;
      },
      exchange: async ({ code, codeVerifier, redirectUri, clientId }) => {
        if (clientId === undefined) {
          return {
            ok: false,
            message: "huggingface connect is not configured",
          };
        }
        const result = await exchangeCodeForToken({
          code,
          codeVerifier: codeVerifier ?? "",
          redirectUri,
          clientId,
        });
        return result.ok
          ? {
              ok: true,
              apiKey: result.accessToken,
              ...(result.expiresAt !== undefined
                ? { expiresAt: result.expiresAt }
                : {}),
            }
          : result;
      },
    },
  };
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
      // Exa authenticates via an `x-api-key` header, not `authorization` —
      // the `http` (Bearer) plugin doesn't fit; see the `http-x-api-key`
      // provider in `@corbits/credential-providers`.
      credentialPlugin: "http-x-api-key",
      displayName: "Exa",
      authKind: "api-key",
      docsUrl: "https://exa.ai",
      feedsTools: ["@corbits/web-search-tools"],
      probe: (apiKey) => testExaCredential(apiKey),
    },
    scrapecreators: {
      id: "scrapecreators",
      // ScrapeCreators, same as Exa, authenticates via `x-api-key`.
      credentialPlugin: "http-x-api-key",
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
    github: {
      id: "github",
      // GitHub's REST API accepts a fine-grained PAT as a Bearer token.
      // Absent entirely, github-tools degrades to a lower unauthenticated
      // rate limit rather than "not connected" — see its tool.ts.
      credentialPlugin: "http",
      displayName: "GitHub",
      authKind: "api-key",
      docsUrl: "https://github.com/settings/tokens",
      feedsTools: ["@corbits/github-tools"],
      probe: (apiKey) => testGitHubCredential(apiKey),
    },
    "granola-webhook": {
      id: "granola-webhook",
      // No credential-provider plugin mediates this connector's secret —
      // it is minted and encrypted entirely inside
      // `@corbits/webhook-triggers` (see `management-routes.ts`), never
      // stored as a Credential row. `credentialPlugin` still has to name
      // something (`ConnectorDescriptor` requires it uniformly); `http`
      // is inert here, kept only so registry-wide invariants (every
      // non-bearer connector reads `http`) hold without a special case.
      credentialPlugin: "http",
      displayName: "Granola inbound webhook",
      authKind: "webhook-secret",
      docsUrl: "https://www.granola.ai",
      // The direction is inverted from the `granola` api-key connector
      // above: this issues a signed inbound address for Granola to call,
      // feeding nothing — a routine's webhook trigger binding, not a
      // tool package's credential handle.
      feedsTools: [],
    },
  };

export function connectorDescriptors(): readonly ConnectorDescriptor[] {
  return Object.values(CONNECTOR_REGISTRY);
}
