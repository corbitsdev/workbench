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

import { type } from "arktype";

const HTTP_URL = /^https?:\/\/.+$/;

const HubEnv = type({
  DATABASE_URL: type(/^postgres(ql)?:\/\/.+$/).describe(
    "a Postgres connection URL, e.g. postgres://workbench:workbench@localhost:5432/workbench",
  ),
  BASE_URL: type(HTTP_URL).describe(
    "an http(s) origin, e.g. http://localhost:3000",
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
  "ANTHROPIC_API_KEY?": type("string > 0").describe(
    "your Anthropic API key; optional, enables the default workflow set for freshly self-served benches",
  ),
});

const DEFAULT_SIGNUP_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_SIGNUP_RATE_LIMIT_MAX = 5;

const SEED_MODEL_PROVIDER = "anthropic";
const SEED_MODEL = "claude-sonnet-5";
const SEED_MODEL_BASE_URL = "https://api.anthropic.com/v1";

export type ModelSource = {
  readonly provider: string;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
};

export type HubConfig = {
  readonly databaseUrl: string;
  readonly baseUrl: string;
  readonly sessionSecret: string;
  readonly hubDataDir: string;
  readonly hubStaticDir: string;
  readonly operatorTenantId?: string;
  readonly signupRateLimit: {
    readonly windowSeconds: number;
    readonly max: number;
  };
  readonly seedModel?: ModelSource;
};

type ParsedHubEnv = typeof HubEnv.infer;

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

  const hubConfig: { -readonly [K in keyof HubConfig]: HubConfig[K] } = {
    databaseUrl: parsed.DATABASE_URL,
    baseUrl: parsed.BASE_URL,
    sessionSecret: parsed.SESSION_SECRET,
    hubDataDir: parsed.HUB_DATA_DIR,
    hubStaticDir: parsed.HUB_STATIC_DIR,
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
  if (seedModel !== undefined) hubConfig.seedModel = seedModel;
  return hubConfig;
}
