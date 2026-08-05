// The one boundary that reads the process environment. Everything the
// hub needs from the outside world is an irreducible deployment fact:
// where the database is, what origin the hub serves, how sessions are
// signed, and where durable state and the built interface live on disk.
// Anything else the hub learns is data in the database, never
// configuration.

import { type } from "arktype";

const HubEnv = type({
  DATABASE_URL: type(/^postgres(ql)?:\/\/.+$/).describe(
    "a Postgres connection URL, e.g. postgres://workbench:workbench@localhost:5432/workbench",
  ),
  BASE_URL: type(/^https?:\/\/.+$/).describe(
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
});

export type HubConfig = {
  readonly databaseUrl: string;
  readonly baseUrl: string;
  readonly sessionSecret: string;
  readonly hubDataDir: string;
  readonly hubStaticDir: string;
};

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
  return {
    databaseUrl: parsed.DATABASE_URL,
    baseUrl: parsed.BASE_URL,
    sessionSecret: parsed.SESSION_SECRET,
    hubDataDir: parsed.HUB_DATA_DIR,
    hubStaticDir: parsed.HUB_STATIC_DIR,
  };
}
