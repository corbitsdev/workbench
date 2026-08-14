// The one boundary that reads the process environment. Everything the
// hub needs from the outside world is an irreducible deployment fact:
// where the database is, what origin the hub serves, how sessions are
// signed, and where durable state and the built interface live on disk.
// Anything else the hub learns is data in the database, never
// configuration.
//
// ANTHROPIC_API_KEY is the one model-related variable the hub reads,
// and it is optional: when set, the hub carries a seed model
// credential (anthropic/claude-sonnet-5) it hands to
// `@workbench/onboarding` so a freshly self-served personal bench gets
// the default workflow set deployed at first login. Left unset, that
// deployment step is skipped — the bench is still provisioned, only
// the default workflow deployment is skipped, and the skip is logged.
//
// GOOGLE_CLIENT_ID/SECRET and GITHUB_CLIENT_ID/SECRET are each an
// optional pair: set both to enable that OAuth provider on the sign-in
// screen, leave both unset to leave it off — email/password remains
// available either way. Setting only one half of a pair is a boot-time
// error, never a silently-disabled provider.
//
// HUGGINGFACE_OAUTH_CLIENT_ID is a single optional value, not a pair —
// Hugging Face's connect flow uses a public OAuth app with no client
// secret. Set it to enable the onboarding wizard's Hugging Face connect
// card; leave it unset and Hugging Face stays available only as a
// paste-a-token provider card.

import { type } from "arktype";

const HTTP_URL = /^https?:\/\/.+$/;

const HubEnv = type({
  DATABASE_URL: type(/^postgres(ql)?:\/\/.+$/).describe(
    "a Postgres connection URL, e.g. postgres://workbench:workbench@localhost:5432/workbench",
  ),
  BASE_URL: type(HTTP_URL).describe(
    "an http(s) origin, e.g. http://localhost:3000",
  ),
  "PORT?": type(/^\d{1,5}$/).describe(
    "the local port to listen on when it differs from BASE_URL's — set this when a reverse proxy (Tailscale serve, nginx) fronts the hub and BASE_URL is the public https origin",
  ),
  SESSION_SECRET: type("string >= 32").describe(
    "a session-signing secret of at least 32 characters",
  ),
  HUB_DATA_DIR: type("string > 0").describe(
    "a filesystem directory for the hub's durable repo and asset state, e.g. .data/hub",
  ),
  HUB_STATIC_DIR: type("string > 0").describe(
    "a directory of built user-interface files the hub serves, e.g. apps/hub/public",
  ),
  "OPERATOR_TENANT_ID?": type("string > 0").describe(
    "the tenant id every self-served personal bench is parented under; optional because the operator tenant it would parent under does not exist as infrastructure yet, and this field lets that land later without a rename",
  ),
  "SIGNUP_RATE_LIMIT_WINDOW_SECONDS?": type(/^[1-9]\d*$/).describe(
    "the per-IP sign-up rate-limit window, in seconds, e.g. 60",
  ),
  "SIGNUP_RATE_LIMIT_MAX?": type(/^[1-9]\d*$/).describe(
    "the maximum sign-ups a single IP may make per window, e.g. 5",
  ),
  "WORKBENCH_SIGNUP?": type("'open' | 'closed'").describe(
    "open = self-serve email signup allowed; closed (default) = owner adds users or copy-link invite only",
  ),
  "WORKBENCH_ALLOWED_EMAIL_DOMAINS?": type("string").describe(
    "comma-separated email domains allowed when WORKBENCH_SIGNUP=open, e.g. acme.example",
  ),
  "ANTHROPIC_API_KEY?": type("string > 0").describe(
    "your Anthropic API key; optional, enables the default workflow set for freshly self-served benches",
  ),
  "GOOGLE_CLIENT_ID?": type("string > 0").describe(
    "Google OAuth client id; set together with GOOGLE_CLIENT_SECRET to enable Google sign-in",
  ),
  "GOOGLE_CLIENT_SECRET?": type("string > 0").describe(
    "Google OAuth client secret; set together with GOOGLE_CLIENT_ID to enable Google sign-in",
  ),
  "GITHUB_CLIENT_ID?": type("string > 0").describe(
    "GitHub OAuth client id; set together with GITHUB_CLIENT_SECRET to enable GitHub sign-in",
  ),
  "GITHUB_CLIENT_SECRET?": type("string > 0").describe(
    "GitHub OAuth client secret; set together with GITHUB_CLIENT_ID to enable GitHub sign-in",
  ),
  "HUGGINGFACE_OAUTH_CLIENT_ID?": type("string > 0").describe(
    "Hugging Face public OAuth app client id (huggingface.co/settings/applications, no secret — see docs/onboarding-huggingface-connect.md); optional, enables the onboarding wizard's Hugging Face connect card",
  ),
  "CREDENTIAL_ENCRYPTION_KEY?": type(/^[0-9a-fA-F]{64}$/).describe(
    "a 64-character hex-encoded 32-byte AES-256 key (openssl rand -hex 32) encrypting secrets at rest through Interchange's CredentialCipher seam — currently webhook-trigger signing secrets; optional in dev/test (secrets fall back to an unencrypted no-op cipher with a boot warning) but should be set for any real deployment",
  ),
});

const DEFAULT_SIGNUP_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_SIGNUP_RATE_LIMIT_MAX = 5;

const SEED_MODEL_PROVIDER = "anthropic";
const SEED_MODEL = "claude-sonnet-5";
const SEED_MODEL_BASE_URL = "https://api.anthropic.com";

export type ModelSource = {
  readonly provider: string;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
};

export type SocialProviderId = "google" | "github";

export type SocialProviderCredential = {
  readonly clientId: string;
  readonly clientSecret: string;
};

export type HubConfig = {
  readonly databaseUrl: string;
  readonly baseUrl: string;
  readonly listenPort?: number;
  readonly sessionSecret: string;
  readonly hubDataDir: string;
  readonly hubStaticDir: string;
  readonly operatorTenantId?: string;
  readonly signupRateLimit: {
    readonly windowSeconds: number;
    readonly max: number;
  };
  /** Self-serve signup. Default closed — see docs/TENANCY.md. */
  readonly signupMode: "open" | "closed";
  /** Domains allowed when signupMode is open. Empty = any domain. */
  readonly allowedEmailDomains: readonly string[];
  readonly seedModel?: ModelSource;
  readonly socialProviders: Readonly<
    Partial<Record<SocialProviderId, SocialProviderCredential>>
  >;
  readonly huggingfaceOAuthClientId?: string;
  readonly credentialEncryptionKeyHex?: string;
};

type ParsedHubEnv = typeof HubEnv.infer;

const SOCIAL_PROVIDER_ENV_KEYS: Record<
  SocialProviderId,
  {
    readonly id: "GOOGLE_CLIENT_ID" | "GITHUB_CLIENT_ID";
    readonly secret: "GOOGLE_CLIENT_SECRET" | "GITHUB_CLIENT_SECRET";
  }
> = {
  google: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  github: { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
};

/**
 * Builds the social-provider credential map. A provider is enabled only
 * when both its id and secret are set; a half-configured pair (one set,
 * the other missing) is a boot-time error — never a silently-disabled
 * provider, per the DX mandate that misconfiguration fails loudly.
 */
function socialProvidersFrom(
  parsed: ParsedHubEnv,
): Readonly<Partial<Record<SocialProviderId, SocialProviderCredential>>> {
  const providers: Partial<Record<SocialProviderId, SocialProviderCredential>> =
    {};
  const errors: string[] = [];
  for (const [providerId, keys] of Object.entries(SOCIAL_PROVIDER_ENV_KEYS) as [
    SocialProviderId,
    (typeof SOCIAL_PROVIDER_ENV_KEYS)[SocialProviderId],
  ][]) {
    const clientId = parsed[keys.id];
    const clientSecret = parsed[keys.secret];
    if (clientId === undefined && clientSecret === undefined) continue;
    if (clientId === undefined || clientSecret === undefined) {
      errors.push(
        `${keys.id} and ${keys.secret} must be set together to enable ${providerId} sign-in; only one is set`,
      );
      continue;
    }
    providers[providerId] = { clientId, clientSecret };
  }
  if (errors.length > 0) {
    throw new Error(
      [
        `invalid hub environment: ${errors.join("; ")}`,
        "Set both values in .env, or unset both to leave the provider disabled; see .env.example.",
      ].join("\n"),
    );
  }
  return providers;
}

function seedModelFrom(parsed: ParsedHubEnv): ModelSource | undefined {
  const apiKey = parsed.ANTHROPIC_API_KEY;
  if (apiKey === undefined) return undefined;
  return {
    provider: SEED_MODEL_PROVIDER,
    model: SEED_MODEL,
    baseURL: SEED_MODEL_BASE_URL,
    apiKey,
  };
}

/**
 * Parse the hub's configuration out of an environment map. Throws at
 * the call site when any variable is missing or malformed, reporting
 * every problem at once and naming each variable and the shape it must
 * have, so a misconfigured process dies at boot instead of failing at
 * first use.
 */
export function readHubConfig(
  env: Record<string, string | undefined>,
): HubConfig {
  const parsed = HubEnv(env);
  if (parsed instanceof type.errors) {
    throw new Error(
      [
        `invalid hub environment: ${parsed.summary}`,
        "Set the values above in .env; see .env.example for the expected shape of each.",
      ].join("\n"),
    );
  }

  const seedModel = seedModelFrom(parsed);
  const socialProviders = socialProvidersFrom(parsed);

  const allowedEmailDomains =
    parsed.WORKBENCH_ALLOWED_EMAIL_DOMAINS === undefined ||
    parsed.WORKBENCH_ALLOWED_EMAIL_DOMAINS.trim() === ""
      ? []
      : parsed.WORKBENCH_ALLOWED_EMAIL_DOMAINS.split(",")
          .map((d) => d.trim())
          .filter((d) => d.length > 0);

  const hubConfig: { -readonly [K in keyof HubConfig]: HubConfig[K] } = {
    databaseUrl: parsed.DATABASE_URL,
    baseUrl: parsed.BASE_URL,
    sessionSecret: parsed.SESSION_SECRET,
    hubDataDir: parsed.HUB_DATA_DIR,
    hubStaticDir: parsed.HUB_STATIC_DIR,
    socialProviders,
    signupMode: parsed.WORKBENCH_SIGNUP ?? "closed",
    allowedEmailDomains,
    signupRateLimit: {
      windowSeconds: parsed.SIGNUP_RATE_LIMIT_WINDOW_SECONDS
        ? Number(parsed.SIGNUP_RATE_LIMIT_WINDOW_SECONDS)
        : DEFAULT_SIGNUP_RATE_LIMIT_WINDOW_SECONDS,
      max: parsed.SIGNUP_RATE_LIMIT_MAX
        ? Number(parsed.SIGNUP_RATE_LIMIT_MAX)
        : DEFAULT_SIGNUP_RATE_LIMIT_MAX,
    },
  };
  if (parsed.OPERATOR_TENANT_ID !== undefined)
    hubConfig.operatorTenantId = parsed.OPERATOR_TENANT_ID;
  if (parsed.PORT !== undefined) hubConfig.listenPort = Number(parsed.PORT);
  if (seedModel !== undefined) hubConfig.seedModel = seedModel;
  if (parsed.HUGGINGFACE_OAUTH_CLIENT_ID !== undefined)
    hubConfig.huggingfaceOAuthClientId = parsed.HUGGINGFACE_OAUTH_CLIENT_ID;
  if (parsed.CREDENTIAL_ENCRYPTION_KEY !== undefined)
    hubConfig.credentialEncryptionKeyHex = parsed.CREDENTIAL_ENCRYPTION_KEY;
  return hubConfig;
}
