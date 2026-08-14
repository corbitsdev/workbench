// The shape every entry in the connector registry (`./registry.ts`)
// implements: enough for the settings-ui Connections surface to render
// a card and, for an api-key connector, drive the test-then-store flow
// `./routes.ts` exposes, or for an oauth-pkce/oauth-code connector,
// drive the connect flow `./oauth-routes.ts` exposes.
import type { CredentialTestResult } from "@workbench/hub-client/credential-test";

export type ConnectorAuthKind =
  "oauth-pkce" | "oauth-code" | "api-key" | "webhook-secret";

/** The result of trading an authorization code for real material —
 * shared across every OAuth connector regardless of whether the
 * provider hands back a durable key (OpenRouter) or an expiring token
 * (Hugging Face). `expiresAt` is an ISO instant, absent for a durable
 * credential. */
export type OAuthExchangeResult =
  | { readonly ok: true; readonly apiKey: string; readonly expiresAt?: string }
  | { readonly ok: false; readonly message: string };

/** Everything `oauth-pkce`/`oauth-code` connect-flow mechanics
 * (`./oauth-routes.ts`) need from a descriptor, generalized from
 * `packages/onboarding`'s hand-written OpenRouter/Hugging Face routes.
 * The mechanics themselves — state sealing, PKCE, cookies, rate
 * limiting, redirect building — live in `oauth-routes.ts`; everything
 * here is provider-specific data or a provider-specific request/response
 * shape. */
export interface ConnectorOAuthConfig {
  /** The provider's own consent-page URL the browser is sent to. */
  readonly authorizeUrl: string;
  /** Whether this flow mints a PKCE pair and sends `code_challenge`.
   * Both connectors wired today (OpenRouter, Hugging Face) are PKCE —
   * kept as a flag for a future `oauth-code` connector that isn't. */
  readonly usesPKCE: boolean;
  /** Whether the provider echoes `state` back as a callback query
   * param, so the callback can cross-check it against the cookie before
   * even consulting the state store (Hugging Face does; OpenRouter,
   * which round-trips state purely via cookie, does not). */
  readonly echoesState: boolean;
  /** Whether a successful connect should also deploy this tenant's
   * default workflows against the newly connected credential (every
   * inference-provider OAuth connector today) or stop at "credential
   * exists, active" (a tool connector, none of which use OAuth yet). */
  readonly deploysDefaultWorkflows: boolean;
  /** Resolves this connector's registered OAuth app id from an
   * operator-supplied env bag. Absent when the flow needs no
   * pre-registered client id (OpenRouter mints one per callback URL);
   * present and returning `undefined` means "not configured" — the
   * connect routes refuse the flow rather than round-trip a doomed
   * request, and the settings-ui card renders the muted "not
   * configured" state instead of a live Connect button. */
  readonly clientId?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => string | undefined;
  /** Builds the full authorize-page URL from the mechanics `oauth-routes.ts`
   * already computed — every provider names its query parameters
   * differently (OpenRouter: `callback_url`; Hugging Face:
   * `redirect_uri` + `client_id` + `scope` + `state`), so this stays a
   * per-descriptor function rather than a forced common param scheme. */
  readonly buildAuthorizeUrl: (args: {
    readonly callbackUrl: string;
    readonly state: string;
    readonly codeChallenge?: string;
    readonly clientId?: string;
  }) => URL;
  /** Trades an authorization code for real material against the
   * provider's token endpoint. */
  readonly exchange: (args: {
    readonly code: string;
    readonly codeVerifier?: string;
    readonly redirectUri: string;
    readonly clientId?: string;
  }) => Promise<OAuthExchangeResult>;
}

export interface ConnectorDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly authKind: ConnectorAuthKind;
  readonly docsUrl: string;
  /**
   * Which credential-provider plugin mediates this connector's secret at
   * run time — the sidecar registers `"http"` (Bearer), `"http-raw-authorization"`
   * (raw `authorization` header, e.g. Linear), and `"http-x-api-key"`
   * (`x-api-key` header, e.g. Exa, ScrapeCreators). Provider rows are
   * seeded with this key; an unknown key means no mediated fetch resolves
   * at capability time.
   */
  readonly credentialPlugin:
    "http" | "http-raw-authorization" | "http-x-api-key";
  /** Tool packages this connector's credential feeds — the settings card's
   * "Pinned by" line. Empty for inference-provider connectors, which feed
   * workflow deployments, not a specific tool package. */
  readonly feedsTools: readonly string[];
  /** api-key connectors only. Absent for oauth-pkce/oauth-code/webhook-secret
   * descriptors. */
  readonly probe?: (apiKey: string) => Promise<CredentialTestResult>;
  /** oauth-pkce/oauth-code connectors only. Absent for api-key/webhook-secret
   * descriptors. */
  readonly oauth?: ConnectorOAuthConfig;
}
