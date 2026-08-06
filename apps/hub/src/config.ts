// The one boundary that reads the process environment. Everything the
// hub needs from the outside world is an irreducible deployment fact:
// where the database is, what origin the hub serves, how sessions are
// signed, and where durable state and the built interface live on disk.
// Anything else the hub learns is data in the database, never
// configuration.
//
// A handful of variables are optional groups rather than single
// values: the hub-owned seed model credential (used to deploy the
// default workflow set for a freshly self-served bench) is either fully
// configured or entirely absent — never partial.

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
  "WORKBENCH_SEED_MODEL_PROVIDER?": type("string > 0"),
  "WORKBENCH_SEED_MODEL?": type("string > 0"),
  "WORKBENCH_SEED_MODEL_BASE_URL?": type(HTTP_URL),
  "WORKBENCH_SEED_MODEL_API_KEY?": type("string > 0"),
});

const DEFAULT_SIGNUP_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_SIGNUP_RATE_LIMIT_MAX = 5;

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

/** A credential group is either fully present or fully absent; a
 * partial group is a configuration mistake, reported loudly rather
 * than silently treated as absent. */
function requireGroupOrNone(
  problems: string[],
  groupName: string,
  fields: Record<string, string | undefined>,
): boolean {
  const present = Object.entries(fields).filter(([, v]) => v !== undefined);
  const missing = Object.entries(fields).filter(([, v]) => v === undefined);
  if (present.length === 0) return false;
  if (missing.length > 0) {
    problems.push(
      `${groupName}: set all of (${Object.keys(fields).join(", ")}) or none — ` +
        `missing ${missing.map(([k]) => k).join(", ")}`,
    );
    return false;
  }
  return true;
}

function seedModelFrom(
  parsed: ParsedHubEnv,
  problems: string[],
): ModelSource | undefined {
  const complete = requireGroupOrNone(problems, "hub seed model credential", {
    WORKBENCH_SEED_MODEL_PROVIDER: parsed.WORKBENCH_SEED_MODEL_PROVIDER,
    WORKBENCH_SEED_MODEL: parsed.WORKBENCH_SEED_MODEL,
    WORKBENCH_SEED_MODEL_BASE_URL: parsed.WORKBENCH_SEED_MODEL_BASE_URL,
    WORKBENCH_SEED_MODEL_API_KEY: parsed.WORKBENCH_SEED_MODEL_API_KEY,
  });
  if (!complete) return undefined;

  const provider = parsed.WORKBENCH_SEED_MODEL_PROVIDER;
  const model = parsed.WORKBENCH_SEED_MODEL;
  const baseURL = parsed.WORKBENCH_SEED_MODEL_BASE_URL;
  const apiKey = parsed.WORKBENCH_SEED_MODEL_API_KEY;
  if (
    typeof provider !== "string" ||
    typeof model !== "string" ||
    typeof baseURL !== "string" ||
    typeof apiKey !== "string"
  ) {
    // requireGroupOrNone already confirmed all four fields are present;
    // this is unreachable in practice and only here so the return below
    // narrows without a cast.
    return undefined;
  }
  return { provider, model, baseURL, apiKey };
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

  const problems: string[] = [];
  const seedModel = seedModelFrom(parsed, problems);
  if (problems.length > 0) {
    throw new Error(
      [
        `invalid hub environment: ${problems.join("; ")}`,
        "Set the values above in .env; see .env.example for the expected shape of each.",
      ].join("\n"),
    );
  }

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
