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
  OLLAMA_PLACEHOLDER_SECRET,
  PROVIDER_TEST_CONFIG,
  testProviderCredential,
  type SupportedCredentialProvider,
} from "@workbench/hub-client/credential-test";
export {
  missingCredentialDetail,
  parseMissingCredentialDetail,
  type MissingCredentialDetail,
} from "./missing-credential-detail";
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
import {
  exchangeCodeForGoogleToken,
  GMAIL_SCOPE,
  GOOGLE_AUTHORIZE_URL,
} from "./gmail-connect";
// simple-icons ships one brand per named export, tree-shaken by any bundler
// that respects its `sideEffects: false` — importing only the brands this
// registry actually has a listing for pulls in only those icons' data, not
// the whole ~3000-brand package (CC0-1.0 licensed — see the package's own
// LICENSE — so redistributing these marks needs no separate clearance).
// Granola and ScrapeCreators have no simple-icons listing (CL-6215's
// plugins-directory rebuild); OpenAI, xAI, Groq, and Opencode Zen have none
// either (CL-6258's connections logos) — those descriptors carry no `icon`,
// so a caller renders their monochrome initial tile instead. Exa publishes
// its own mark in its official brand kit, used below. Google's mark
// here is Gemini's, not the generic Google "G" — the model brand a person
// actually recognizes from connecting an AI provider, matching
// models.dev's own convention for this row.
import {
  siAnthropic,
  siDeepseek,
  siGithub,
  siGmail,
  siGooglegemini,
  siHuggingface,
  siLinear,
  siMistralai,
  siOllama,
  siOpenrouter,
} from "simple-icons";
import { exchangeCodeForKey, OPENROUTER_AUTH_URL } from "./openrouter-connect";
import {
  exchangeCodeForGithubToken,
  GITHUB_AUTHORIZE_URL,
} from "./github-connect";
import {
  testExaCredential,
  testGitHubCredential,
  testGranolaCredential,
  testLinearCredential,
  testManusCredential,
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
  ollama: "https://ollama.com",
};

// Ollama's onboarding URL field default — the local-machine origin
// Ollama listens on out of the box, before anyone points it at a
// tailscale-tunneled or otherwise remote instance.
const OLLAMA_DEFAULT_URL = "http://localhost:11434";

const EXA_ICON = {
  path: "M150.5 14.1064C150.5 14.3356 150.421 14.5579 150.277 14.736L88.4766 91 150.277 167.264C150.421 167.442 150.5 167.664 150.5 167.894V181C150.5 181.552 150.052 182 149.5 182H1C0.44772 182 0 181.552 0 181V0.999995C0 0.44771 0.447715 0 1 0H149.5C150.052 0 150.5 0.447715 150.5 1V14.1064ZM30.4059 162.719H121.728L76.0664 106.326 30.4059 162.719ZM19.2949 100.261V145.787L56.1572 100.261H19.2949ZM19.2949 80.9801H55.5434L19.2949 36.2121V80.9801ZM76.0664 75.6731L121.728 19.281H30.4059L76.0664 75.6731Z",
  hex: "0143D9",
  viewBox: "0 0 151 182",
} as const;

// Every inference provider with a simple-icons listing. OpenAI, xAI, Groq,
// and Opencode Zen have none as of simple-icons' current release; those
// four fall through to the monochrome initial tile every iconless
// descriptor already gets.
const INFERENCE_PROVIDER_ICONS: Partial<
  Record<
    SupportedCredentialProvider,
    { readonly path: string; readonly hex: string }
  >
> = {
  anthropic: { path: siAnthropic.path, hex: siAnthropic.hex },
  "google-genai": { path: siGooglegemini.path, hex: siGooglegemini.hex },
  deepseek: { path: siDeepseek.path, hex: siDeepseek.hex },
  mistral: { path: siMistralai.path, hex: siMistralai.hex },
  ollama: { path: siOllama.path, hex: siOllama.hex },
  openrouter: { path: siOpenrouter.path, hex: siOpenrouter.hex },
  huggingface: { path: siHuggingface.path, hex: siHuggingface.hex },
};

function inferenceProviderDescriptors(): Record<string, ConnectorDescriptor> {
  const entries: Record<string, ConnectorDescriptor> = {};
  for (const [id, config] of Object.entries(PROVIDER_TEST_CONFIG)) {
    if (id === "openrouter" || id === "huggingface") continue;
    const providerId = id as SupportedCredentialProvider;
    // Ollama collects a URL, not a secret — it has no auth layer at all
    // (see `credential-test.ts`'s own `ollama` config entry). Every
    // other connector's single form field is a real key, probed and
    // stored as-is.
    const icon = INFERENCE_PROVIDER_ICONS[providerId];
    entries[id] =
      providerId === "ollama"
        ? {
            id,
            displayName: config.displayName,
            authKind: "api-key",
            credentialPlugin: "http",
            docsUrl: INFERENCE_PROVIDER_DOCS_URL[providerId],
            feedsTools: [],
            credentialInputKind: "url",
            credentialPlaceholder: OLLAMA_DEFAULT_URL,
            probe: (baseURL) =>
              testProviderCredential({
                provider: providerId,
                apiKey: OLLAMA_PLACEHOLDER_SECRET,
                baseURL,
              }),
            ...(icon !== undefined ? { icon } : {}),
          }
        : {
            id,
            displayName: config.displayName,
            authKind: "api-key",
            credentialPlugin: "http",
            docsUrl: INFERENCE_PROVIDER_DOCS_URL[providerId],
            feedsTools: [],
            probe: (apiKey) =>
              testProviderCredential({ provider: providerId, apiKey }),
            ...(icon !== undefined ? { icon } : {}),
          };
  }
  entries["openrouter"] = {
    id: "openrouter",
    displayName: PROVIDER_TEST_CONFIG.openrouter.displayName,
    authKind: "oauth-pkce",
    credentialPlugin: "http",
    docsUrl: INFERENCE_PROVIDER_DOCS_URL.openrouter,
    feedsTools: [],
    icon: { path: siOpenrouter.path, hex: siOpenrouter.hex },
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
    icon: { path: siHuggingface.path, hex: siHuggingface.hex },
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
        if (!result.ok) return result;
        return result.expiresAt !== undefined
          ? {
              ok: true,
              apiKey: result.accessToken,
              expiresAt: result.expiresAt,
            }
          : { ok: true, apiKey: result.accessToken };
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
      description: "Pull meeting notes and transcripts into your agents.",
    },
    manus: {
      id: "manus",
      credentialPlugin: "http-x-manus-api-key",
      displayName: "Manus",
      authKind: "api-key",
      docsUrl: "https://open.manus.ai/docs/v2/introduction",
      feedsTools: ["@corbits/manus-tools"],
      probe: (apiKey) => testManusCredential(apiKey),
      description:
        "Have Manus run tasks and produce files — including slide decks.",
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
      description: "Neural web search built for agents.",
      icon: EXA_ICON,
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
      description: "Read Reddit threads and comments.",
    },
    linear: {
      id: "linear",
      credentialPlugin: "http-raw-authorization",
      displayName: "Linear",
      authKind: "api-key",
      docsUrl: "https://linear.app/settings/api",
      feedsTools: ["@corbits/linear-tools"],
      probe: (apiKey) => testLinearCredential(apiKey),
      description: "Read and write issues, projects, and comments.",
      icon: { path: siLinear.path, hex: siLinear.hex },
    },
    gmail: {
      id: "gmail",
      displayName: "Gmail",
      // Pure hosted-app OAuth — there is no Gmail equivalent of a PAT
      // to paste, so unlike `github` below this connector has no
      // api-key arm: unconfigured (`GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`
      // unset) means the card renders "not configured", never a dead
      // paste form. The exchanged access token expires in about an
      // hour; the refresh token rides `OAuthExchangeResult.refreshToken`
      // into the credential row's `refreshSecret` so a refresh sweep
      // can keep the connection alive.
      authKind: "oauth-code",
      credentialPlugin: "http",
      docsUrl: "https://developers.google.com/gmail/api",
      feedsTools: [],
      description: "Read, draft, and send email — sending waits for your ok.",
      icon: { path: siGmail.path, hex: siGmail.hex },
      oauth: {
        authorizeUrl: GOOGLE_AUTHORIZE_URL,
        usesPKCE: true,
        echoesState: true,
        deploysDefaultWorkflows: false,
        clientId: (env) => env["gmailClientId"],
        clientSecret: (env) => env["gmailClientSecret"],
        buildAuthorizeUrl: ({
          callbackUrl,
          state,
          codeChallenge,
          clientId,
        }) => {
          const url = new URL(GOOGLE_AUTHORIZE_URL);
          if (clientId !== undefined)
            url.searchParams.set("client_id", clientId);
          url.searchParams.set("redirect_uri", callbackUrl);
          url.searchParams.set("response_type", "code");
          url.searchParams.set("scope", GMAIL_SCOPE);
          url.searchParams.set("state", state);
          // `offline` + forced consent is what makes Google issue a
          // refresh token at all — without both, a re-connect silently
          // returns only another one-hour access token.
          url.searchParams.set("access_type", "offline");
          url.searchParams.set("prompt", "consent");
          if (codeChallenge !== undefined) {
            url.searchParams.set("code_challenge", codeChallenge);
            url.searchParams.set("code_challenge_method", "S256");
          }
          return url;
        },
        exchange: async ({
          code,
          codeVerifier,
          redirectUri,
          clientId,
          clientSecret,
        }) => {
          if (clientId === undefined || clientSecret === undefined) {
            return {
              ok: false,
              message: "gmail connect is not configured",
            };
          }
          return exchangeCodeForGoogleToken({
            code,
            ...(codeVerifier !== undefined ? { codeVerifier } : {}),
            redirectUri,
            clientId,
            clientSecret,
          });
        },
      },
    },
    github: {
      id: "github",
      // GitHub's REST API accepts a fine-grained PAT — or a GitHub OAuth
      // App user token, which is the same Bearer shape — as a Bearer
      // token. Absent entirely, github-tools degrades to a lower
      // unauthenticated rate limit rather than "not connected" — see its
      // tool.ts. `authKind` stays "api-key" (the PAT paste form is
      // always available, CL-6386's guaranteed fallback); the `oauth`
      // config below is this connector's one exception to "oauth fields
      // are oauth-pkce/oauth-code only" — a caller checks
      // `GET /oauth-configured`'s `github` entry to decide whether to
      // offer the one-click app connect ahead of the paste form, never
      // the other way around, so an unconfigured deploy never dead-ends.
      credentialPlugin: "http",
      displayName: "GitHub",
      authKind: "api-key",
      docsUrl: "https://github.com/settings/tokens",
      feedsTools: ["@corbits/github-tools"],
      probe: (apiKey, opts) =>
        testGitHubCredential(apiKey, undefined, opts?.baseUrl),
      description: "Read repos, issues, and pull requests.",
      icon: { path: siGithub.path, hex: siGithub.hex },
      oauth: {
        authorizeUrl: GITHUB_AUTHORIZE_URL,
        usesPKCE: false,
        echoesState: true,
        deploysDefaultWorkflows: false,
        clientId: (env) => env["githubAppClientId"],
        clientSecret: (env) => env["githubAppClientSecret"],
        buildAuthorizeUrl: ({ callbackUrl, state, clientId }) => {
          const url = new URL(GITHUB_AUTHORIZE_URL);
          if (clientId !== undefined)
            url.searchParams.set("client_id", clientId);
          url.searchParams.set("redirect_uri", callbackUrl);
          url.searchParams.set("scope", "repo");
          url.searchParams.set("state", state);
          return url;
        },
        exchange: async ({ code, redirectUri, clientId, clientSecret }) => {
          if (clientId === undefined || clientSecret === undefined) {
            return {
              ok: false,
              message: "github app connect is not configured",
            };
          }
          const result = await exchangeCodeForGithubToken({
            code,
            redirectUri,
            clientId,
            clientSecret,
          });
          return result.ok ? { ok: true, apiKey: result.key } : result;
        },
      },
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
