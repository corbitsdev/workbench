// The one place the command-line interface reads the process
// environment. Each verb has a single schema, every missing or
// malformed variable is reported at once, and every report names the
// exact fix.

import { type } from "arktype";
import { CliError } from "./errors";

const HTTP_URL = /^https?:\/\/.+$/;

const SharedEnv = {
  "WORKBENCH_HUB_URL?": type(HTTP_URL).describe(
    "the hub origin, e.g. http://localhost:3000",
  ),
  "BASE_URL?": type(HTTP_URL).describe(
    "an http(s) origin, e.g. http://localhost:3000",
  ),
  WORKBENCH_ADMIN_EMAIL: type(/^[^@\s]+@[^@\s]+$/).describe(
    "the email address for the administrator account, e.g. admin@example.com",
  ),
  WORKBENCH_ADMIN_PASSWORD: type("string >= 8").describe(
    "the administrator password, at least 8 characters",
  ),
  "WORKBENCH_ORG_SLUG?": type(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).describe(
    "a lowercase-kebab bench slug, e.g. workbench",
  ),
} as const;

const SetupEnv = type({
  ...SharedEnv,
  "WORKBENCH_ORG_NAME?": type("string > 0").describe(
    "the bench display name, e.g. Workbench",
  ),
});

const SeedEnv = type({
  ...SharedEnv,
  WORKBENCH_MODEL_PROVIDER: type("string > 0").describe(
    "the inference provider name, e.g. anthropic",
  ),
  WORKBENCH_MODEL: type("string > 0").describe(
    "the model identifier at the provider, e.g. claude-sonnet-4-5",
  ),
  WORKBENCH_MODEL_BASE_URL: type(HTTP_URL).describe(
    "the provider API base URL, e.g. https://api.anthropic.com/v1",
  ),
  WORKBENCH_MODEL_API_KEY: type("string > 0").describe(
    "your API key at the provider; the hub never generates this for you",
  ),
});

export type SetupConfig = {
  readonly hubUrl: string;
  readonly adminEmail: string;
  readonly adminPassword: string;
  readonly orgName: string;
  readonly orgSlug: string;
};

export type ModelSource = {
  readonly provider: string;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
};

export type SeedConfig = {
  readonly hubUrl: string;
  readonly adminEmail: string;
  readonly adminPassword: string;
  readonly orgSlug: string;
  readonly modelSource: ModelSource;
};

function environmentError(command: string, problems: string[]): CliError {
  return new CliError(
    `invalid environment for \`workbench ${command}\`:\n  ${problems.join("\n  ")}`,
    "set the variables above (in .env at the repository root, or exported in the environment), then re-run the command",
  );
}

function resolveHubURL(env: {
  WORKBENCH_HUB_URL?: string;
  BASE_URL?: string;
}): string | undefined {
  return env.WORKBENCH_HUB_URL ?? env.BASE_URL;
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
      "WORKBENCH_HUB_URL or BASE_URL must name the hub origin, e.g. http://localhost:3000",
    ]);
  }
  return {
    hubUrl,
    adminEmail: parsed.WORKBENCH_ADMIN_EMAIL,
    adminPassword: parsed.WORKBENCH_ADMIN_PASSWORD,
    orgName: parsed.WORKBENCH_ORG_NAME ?? "Workbench",
    orgSlug: parsed.WORKBENCH_ORG_SLUG ?? "workbench",
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
      "WORKBENCH_HUB_URL or BASE_URL must name the hub origin, e.g. http://localhost:3000",
    ]);
  }
  return {
    hubUrl,
    adminEmail: parsed.WORKBENCH_ADMIN_EMAIL,
    adminPassword: parsed.WORKBENCH_ADMIN_PASSWORD,
    orgSlug: parsed.WORKBENCH_ORG_SLUG ?? "workbench",
    modelSource: {
      provider: parsed.WORKBENCH_MODEL_PROVIDER,
      model: parsed.WORKBENCH_MODEL,
      baseURL: parsed.WORKBENCH_MODEL_BASE_URL,
      apiKey: parsed.WORKBENCH_MODEL_API_KEY,
    },
  };
}

/**
 * The variables `workbench seed` requires beyond what setup consumed —
 * above all the operator's own model credential. `setup` prints these
 * so the one thing the platform cannot provision for you is never a
 * surprise.
 */
export const MODEL_CREDENTIAL_VARIABLES = [
  "WORKBENCH_MODEL_PROVIDER (e.g. anthropic)",
  "WORKBENCH_MODEL (e.g. claude-sonnet-4-5)",
  "WORKBENCH_MODEL_BASE_URL (e.g. https://api.anthropic.com/v1)",
  "WORKBENCH_MODEL_API_KEY (your own API key; never stored by setup)",
] as const;
