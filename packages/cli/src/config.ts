// The one place the command-line interface reads the process
// environment. Each verb has a single schema, every missing or
// malformed variable is reported at once, and every report names the
// exact fix.
//
// The identity env (HUB_ADMIN_EMAIL / HUB_ADMIN_PASSWORD) matches
// Interchange's own naming so `scripts/dev.ts`'s account seeding and
// this CLI never disagree about which variables name the
// administrator. ANTHROPIC_API_KEY is the only model-related
// variable, and it is optional: `workbench seed` always deploys the
// default workflow set (using a placeholder key when it is unset) and
// always plants the tenant catalog's model data; only the catalog
// credential — the thing that actually makes a channel or workflow
// launchable — depends on a real key being set.

import { type } from "arktype";
import {
  CliError,
  PLACEHOLDER_CATALOG_API_KEY,
  type ModelSource,
} from "@workbench/hub-client";

const HTTP_URL = /^https?:\/\/.+$/;

const SharedEnv = {
  "HUB_URL?": type(HTTP_URL).describe(
    "the hub origin, e.g. http://localhost:3000",
  ),
  "BASE_URL?": type(HTTP_URL).describe(
    "an http(s) origin, e.g. http://localhost:3000",
  ),
  "HUB_ADMIN_EMAIL?": type(/^[^@\s]+@[^@\s]+$/).describe(
    "the email address for the administrator account, e.g. admin@example.com",
  ),
  "HUB_ADMIN_PASSWORD?": type("string >= 8").describe(
    "the administrator password, at least 8 characters",
  ),
  "ORG_SLUG?": type(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).describe(
    "a lowercase-kebab bench slug, e.g. workbench",
  ),
} as const;

const SetupEnv = type({
  ...SharedEnv,
  "ORG_NAME?": type("string > 0").describe(
    "the bench display name, e.g. Workbench",
  ),
});

const SeedEnv = type({
  ...SharedEnv,
  "ANTHROPIC_API_KEY?": type("string > 0").describe(
    "your Anthropic API key; optional, but required for the tenant catalog to be launchable",
  ),
  "WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS?": type("string").describe(
    "set to 1 to also deploy the zero-cost catalog-test workflow (heartbeat); a dev/CI-only opt-in, never set for a real bench",
  ),
});

const DEFAULT_MODEL_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MODEL_BASE_URL = "https://api.anthropic.com";

export type SetupConfig = {
  readonly hubUrl: string;
  readonly adminEmail: string;
  readonly adminDefaulted: boolean;
  readonly adminPassword: string;
  readonly orgName: string;
  readonly orgSlug: string;
};

export type { ModelSource };

export type SeedConfig = {
  readonly hubUrl: string;
  readonly adminEmail: string;
  readonly adminDefaulted: boolean;
  readonly adminPassword: string;
  readonly orgSlug: string;
  /** Always anthropic/claude-sonnet-5; carries a placeholder key when
   * ANTHROPIC_API_KEY is unset, so the default workflow set still
   * deploys. */
  readonly modelSource: ModelSource;
  readonly anthropicApiKeyConfigured: boolean;
  /**
   * Opt-in, from WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS: also deploy
   * the zero-cost catalog-test workflow (heartbeat)
   * alongside the real default set. Unset for a real bench — these
   * exist only to exercise the platform, not for a real user.
   */
  readonly seedCatalogTestWorkflows: boolean;
};

function environmentError(command: string, problems: string[]): CliError {
  return new CliError(
    `invalid environment for \`workbench ${command}\`:\n  ${problems.join("\n  ")}`,
    "set the variables above (in .env at the repository root, or exported in the environment), then re-run the command",
  );
}

function resolveHubURL(env: {
  HUB_URL?: string;
  BASE_URL?: string;
}): string | undefined {
  return env.HUB_URL ?? env.BASE_URL;
}

// Interchange's own dev tooling defaults the admin identity ("unset
// values fall back to the seed defaults") so a fresh clone runs with
// zero .env edits. Real deployments set HUB_ADMIN_EMAIL and
// HUB_ADMIN_PASSWORD; the loud line below is the reminder.
const DEFAULT_ADMIN_EMAIL = "alice@example.com";
const DEFAULT_ADMIN_PASSWORD = "password123";

function adminIdentityFrom(parsed: {
  HUB_ADMIN_EMAIL?: string;
  HUB_ADMIN_PASSWORD?: string;
}): { adminEmail: string; adminPassword: string; adminDefaulted: boolean } {
  return {
    adminEmail: parsed.HUB_ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL,
    adminPassword: parsed.HUB_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD,
    adminDefaulted:
      parsed.HUB_ADMIN_EMAIL === undefined ||
      parsed.HUB_ADMIN_PASSWORD === undefined,
  };
}

/** Parse the environment `workbench setup` needs, or fail loudly. */
export function readSetupConfig(
  env: Record<string, string | undefined>,
): SetupConfig {
  const parsed = SetupEnv(env);
  if (parsed instanceof type.errors) {
    throw environmentError("setup", [parsed.summary]);
  }
  const hubUrl = resolveHubURL(parsed);
  if (hubUrl === undefined) {
    throw environmentError("setup", [
      "HUB_URL or BASE_URL must name the hub origin, e.g. http://localhost:3000",
    ]);
  }
  const admin = adminIdentityFrom(parsed);
  return {
    hubUrl,
    adminEmail: admin.adminEmail,
    adminPassword: admin.adminPassword,
    adminDefaulted: admin.adminDefaulted,
    orgName: parsed.ORG_NAME ?? "Workbench",
    orgSlug: parsed.ORG_SLUG ?? "workbench",
  };
}

/** Parse the environment `workbench seed` needs, or fail loudly. */
export function readSeedConfig(
  env: Record<string, string | undefined>,
): SeedConfig {
  const parsed = SeedEnv(env);
  if (parsed instanceof type.errors) {
    throw environmentError("seed", [parsed.summary]);
  }
  const hubUrl = resolveHubURL(parsed);
  if (hubUrl === undefined) {
    throw environmentError("seed", [
      "HUB_URL or BASE_URL must name the hub origin, e.g. http://localhost:3000",
    ]);
  }
  const apiKey = parsed.ANTHROPIC_API_KEY;
  const admin = adminIdentityFrom(parsed);
  return {
    hubUrl,
    adminEmail: admin.adminEmail,
    adminPassword: admin.adminPassword,
    adminDefaulted: admin.adminDefaulted,
    orgSlug: parsed.ORG_SLUG ?? "workbench",
    modelSource: {
      provider: DEFAULT_MODEL_PROVIDER,
      model: DEFAULT_MODEL,
      baseURL: DEFAULT_MODEL_BASE_URL,
      apiKey: apiKey ?? PLACEHOLDER_CATALOG_API_KEY,
    },
    anthropicApiKeyConfigured: apiKey !== undefined,
    seedCatalogTestWorkflows:
      parsed.WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS === "1",
  };
}

/**
 * The variable `workbench seed` reads for its model credential.
 * `setup` prints this so the one thing the platform cannot provision
 * for you is never a surprise; it is optional — seeding still deploys
 * the default workflow set and plants the tenant catalog's model data
 * without it, but nothing is launchable until it is set.
 */
export const MODEL_CREDENTIAL_VARIABLES = [
  "ANTHROPIC_API_KEY (optional; your Anthropic API key, needed to make the catalog launchable)",
] as const;
