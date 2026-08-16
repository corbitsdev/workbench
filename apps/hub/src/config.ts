// The one boundary that reads the process environment. Everything the
// hub needs from the outside world is an irreducible deployment fact:
// where the database is, what origin the hub serves, how sessions are
// signed, and where durable state and the built interface live on disk.
// Anything else the hub learns is data in the database, never
// configuration.
//
// ANTHROPIC_API_KEY is the one model-related variable a freshly
// self-served personal bench needs: when set, the hub carries a seed
// model credential (anthropic/claude-sonnet-5) it hands to
// `@workbench/onboarding` so that bench gets the default workflow set
// deployed at first login. Left unset, that deployment step is skipped
// — the bench is still provisioned, only the default workflow
// deployment is skipped, and the skip is logged.
//
// ANTHROPIC_API_KEY and every other curated provider's conventional key
// (`@workbench/onboarding`'s `PROVIDER_ENV_VARS` — OPENAI_API_KEY,
// GEMINI_API_KEY/GOOGLE_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY,
// OPENCODE_ZEN_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY, MISTRAL_API_KEY,
// HUGGINGFACE_API_KEY) are also read as an env-key auto-plant (CL-6101):
// once the hub finds its own operator bench (HUB_ADMIN_EMAIL/PASSWORD
// signed in, ORG_SLUG resolved — the same identity `workbench setup` /
// `workbench seed` use), it plants a real, probed credential for every
// key it finds there, making that bench's catalog launchable with no
// `workbench seed` re-run. See `../env-credential-plant.ts`. All of
// these — including HUB_ADMIN_EMAIL/PASSWORD/ORG_SLUG — are optional:
// the plant is skipped, quietly and non-fatally, whenever the admin
// identity cannot be resolved or no provider key is set.
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
import { envProviderKeysFrom } from "@workbench/onboarding";
import type { SupportedCredentialProvider } from "@workbench/hub-client";

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
    "your Anthropic API key; optional, enables the default workflow set for freshly self-served benches, and auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "OPENAI_API_KEY?": type("string > 0").describe(
    "your OpenAI API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "GEMINI_API_KEY?": type("string > 0").describe(
    "your Google Gemini API key; optional, auto-plants a probed catalog credential on the operator bench at hub start — GOOGLE_API_KEY is used when this is unset",
  ),
  "GOOGLE_API_KEY?": type("string > 0").describe(
    "your Google Gemini API key, under its other common name; only read when GEMINI_API_KEY is unset",
  ),
  "XAI_API_KEY?": type("string > 0").describe(
    "your xAI API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "OPENROUTER_API_KEY?": type("string > 0").describe(
    "your OpenRouter API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "OPENCODE_ZEN_API_KEY?": type("string > 0").describe(
    "your Opencode Zen API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "GROQ_API_KEY?": type("string > 0").describe(
    "your Groq API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "DEEPSEEK_API_KEY?": type("string > 0").describe(
    "your DeepSeek API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "MISTRAL_API_KEY?": type("string > 0").describe(
    "your Mistral API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "HUGGINGFACE_API_KEY?": type("string > 0").describe(
    "your Hugging Face router API token; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "HUB_ADMIN_EMAIL?": type(/^[^@\s]+@[^@\s]+$/).describe(
    "the administrator account the env-key auto-plant signs in as to find the operator bench; same identity `workbench setup`/`workbench seed` use — unset falls back to alice@example.com, the same default those commands use",
  ),
  "HUB_ADMIN_PASSWORD?": type("string >= 8").describe(
    "the administrator password the env-key auto-plant signs in with; unset falls back to password123, the same default `workbench setup`/`workbench seed` use",
  ),
  "ORG_SLUG?": type(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).describe(
    "the operator bench slug the env-key auto-plant resolves; same variable `workbench setup`/`workbench seed` read — unset falls back to \"workbench\"",
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
    "a 64-character hex-encoded 32-byte AES-256 key (openssl rand -hex 32) encrypting secrets at rest through Interchange's CredentialCipher seam — webhook-trigger signing secrets and onboarding's OAuth PKCE connect state; boot fails without it unless ALLOW_PLAINTEXT_SECRETS opts into dev/test's unencrypted fallback",
  ),
  "ALLOW_PLAINTEXT_SECRETS?": type("'1' | 'true'").describe(
    "dev/test-only opt-in to boot without CREDENTIAL_ENCRYPTION_KEY, storing secrets at rest unencrypted with a boot warning; never set this for a real deployment",
  ),
  "ALLOW_UNVERIFIED_EMAILS?": type("'1' | 'true'").describe(
    "dev/test-only opt-in to let @workbench/access-policy trust an email that better-auth has not verified — self-signup domain checks and pending-invite redemption normally require emailVerified; never set this for a real deployment",
  ),
  "SIDECAR_PROVISIONER?": type("'docker'").describe(
    "the sidecar-allocation backend for workbenches placed on their own exclusive sidecar; unset (default) keeps the hub on its current single shared sidecar with no exclusive-placement backend available, 'docker' provisions one container per allocation via @corbits/docker-provisioner",
  ),
  "DOCKER_PROVISIONER_IMAGE?": type("string > 0").describe(
    "the container image the docker sidecar provisioner runs for each exclusive allocation; required when SIDECAR_PROVISIONER=docker",
  ),
  "HUB_SIDECAR_WEBSOCKET_URL?": type(/^wss?:\/\/.+$/).describe(
    "the ws(s):// URL a provisioned sidecar container dials back to reach this hub; unset (default) derives it from BASE_URL, which is wrong for a docker sidecar provisioner — that container's own localhost is itself, not the hub host — so set this whenever SIDECAR_PROVISIONER=docker",
  ),
});

const DEFAULT_SIGNUP_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_SIGNUP_RATE_LIMIT_MAX = 5;

const SEED_MODEL_PROVIDER = "anthropic";
const SEED_MODEL = "claude-sonnet-5";
const SEED_MODEL_BASE_URL = "https://api.anthropic.com";

// Matches `workbench setup`/`workbench seed`'s own defaults
// (packages/cli/src/config.ts) exactly, so a zero-.env-edit local
// checkout that seeds its admin account through `bun run dev` also
// resolves the same operator bench for the env-key auto-plant with no
// extra configuration.
const DEFAULT_PLANT_ADMIN_EMAIL = "alice@example.com";
const DEFAULT_PLANT_ADMIN_PASSWORD = "password123";
const DEFAULT_PLANT_ORG_SLUG = "workbench";

export type ModelSource = {
  readonly provider: string;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
};

export type SidecarProvisionerConfig =
  | { readonly kind: "none" }
  | { readonly kind: "docker"; readonly image: string };

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
  /** Dev/test-only opt-in to boot without CREDENTIAL_ENCRYPTION_KEY. */
  readonly allowPlaintextSecrets: boolean;
  /** Dev/test-only opt-in to skip @workbench/access-policy's email-
   * verification requirement. */
  readonly allowUnverifiedEmails: boolean;
  readonly sidecarProvisioner: SidecarProvisionerConfig;
  /** Overrides the ws(s):// URL a provisioned sidecar dials back to reach
   * this hub. Unset derives it from baseUrl instead. */
  readonly sidecarWebSocketUrl?: string;
  /** Every curated provider's key found under its conventional env var
   * name (`@workbench/onboarding`'s `PROVIDER_ENV_VARS`). Empty when
   * none are set — the env-key auto-plant then does nothing. */
  readonly envProviderKeys: Partial<Record<SupportedCredentialProvider, string>>;
  /** The identity the env-key auto-plant signs in as to find the
   * operator bench — the same identity `workbench setup`/`workbench
   * seed` use, defaulted the same way when unset. Always populated
   * (never optional): an unset HUB_ADMIN_EMAIL/PASSWORD/ORG_SLUG is a
   * valid local-dev shape, not a reason to skip the plant outright —
   * the plant itself degrades to a no-op, logged, when this identity
   * does not resolve to a real operator bench. */
  readonly envCredentialPlantAdmin: {
    readonly email: string;
    readonly password: string;
    readonly orgSlug: string;
  };
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

/**
 * Resolves the sidecar-provisioner backend. `SIDECAR_PROVISIONER=docker`
 * requires `DOCKER_PROVISIONER_IMAGE`; a half-configured pair fails boot
 * loudly rather than silently falling back to the no-provisioner default.
 */
function sidecarProvisionerFrom(
  parsed: ParsedHubEnv,
): SidecarProvisionerConfig {
  if (parsed.SIDECAR_PROVISIONER === undefined) return { kind: "none" };
  if (parsed.DOCKER_PROVISIONER_IMAGE === undefined) {
    throw new Error(
      [
        "invalid hub environment: DOCKER_PROVISIONER_IMAGE must be set when SIDECAR_PROVISIONER=docker",
        "Set DOCKER_PROVISIONER_IMAGE in .env, or unset SIDECAR_PROVISIONER to leave exclusive sidecar placement disabled; see .env.example.",
      ].join("\n"),
    );
  }
  return { kind: "docker", image: parsed.DOCKER_PROVISIONER_IMAGE };
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
    allowPlaintextSecrets: parsed.ALLOW_PLAINTEXT_SECRETS !== undefined,
    allowUnverifiedEmails: parsed.ALLOW_UNVERIFIED_EMAILS !== undefined,
    sidecarProvisioner: sidecarProvisionerFrom(parsed),
    signupRateLimit: {
      windowSeconds: parsed.SIGNUP_RATE_LIMIT_WINDOW_SECONDS
        ? Number(parsed.SIGNUP_RATE_LIMIT_WINDOW_SECONDS)
        : DEFAULT_SIGNUP_RATE_LIMIT_WINDOW_SECONDS,
      max: parsed.SIGNUP_RATE_LIMIT_MAX
        ? Number(parsed.SIGNUP_RATE_LIMIT_MAX)
        : DEFAULT_SIGNUP_RATE_LIMIT_MAX,
    },
    envProviderKeys: envProviderKeysFrom(parsed),
    envCredentialPlantAdmin: {
      email: parsed.HUB_ADMIN_EMAIL ?? DEFAULT_PLANT_ADMIN_EMAIL,
      password: parsed.HUB_ADMIN_PASSWORD ?? DEFAULT_PLANT_ADMIN_PASSWORD,
      orgSlug: parsed.ORG_SLUG ?? DEFAULT_PLANT_ORG_SLUG,
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
  if (parsed.HUB_SIDECAR_WEBSOCKET_URL !== undefined)
    hubConfig.sidecarWebSocketUrl = parsed.HUB_SIDECAR_WEBSOCKET_URL;
  return hubConfig;
}
