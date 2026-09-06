// The env-gate half of scripts/e2e/harness.ts, split out so a DB-gated
// unit suite (every package's migrations.test.ts / *.drizzle.test.ts)
// can resolve DATABASE_URL without pulling in harness.ts's process-
// spawning machinery — which imports @corbits/seeding and
// @corbits/workflows, and with them the full @intx/* module graph.
// That import chain costs over a second per test file purely to load,
// paid by every package's build-test run whether or not the suite
// ever runs (most don't: no DATABASE_URL locally, and build-test never
// provisions Postgres). harness.ts re-exports everything here so the
// handful of suites that do spawn the hub/sidecar keep one import.
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertDatabaseConfigured } from "./db-gate.ts";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

// --- environment gate -------------------------------------------------

/**
 * The suite needs a real Postgres, named by DATABASE_URL. Locally a
 * missing DATABASE_URL skips the suite (a fresh checkout without a
 * database still runs the unit gates); in CI, CI=true turns that skip
 * into a loud failure so the suite can never silently vanish from the
 * pipeline.
 *
 * `bun test` workers do not always inherit process.env.DATABASE_URL
 * even when the shell sourced `.env`. Fall back to the same repo-root
 * `.env` file `bun run` would load.
 */
export function e2eDatabaseUrl(): string | undefined {
  const fromProcess = process.env["DATABASE_URL"];
  const url =
    fromProcess !== undefined && fromProcess !== ""
      ? fromProcess
      : databaseUrlFromRepoEnvFile();
  if (url !== undefined && url !== "") return baseUrlToE2eUrl(url);
  assertDatabaseConfigured(undefined, "walking-skeleton suite");
  return undefined;
}

/**
 * Pull DATABASE_URL from a dotenv-style file body. Ignores blanks and
 * comments; trims; strips one layer of surrounding quotes. Last match
 * wins. Does not expand interpolations.
 */
export function parseEnvFileDatabaseUrl(text: string): string | undefined {
  let found: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!line.startsWith("DATABASE_URL=")) continue;
    let value = line.slice("DATABASE_URL=".length).trim();
    if (value.length >= 2) {
      const start = value[0];
      const end = value[value.length - 1];
      if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
        value = value.slice(1, -1);
      }
    }
    found = value;
  }
  if (found === undefined || found === "") return undefined;
  return found;
}

function databaseUrlFromRepoEnvFile(): string | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, ".env"), "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  return parseEnvFileDatabaseUrl(text);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * The suite tears its schema down and rebuilds it on every run, so it
 * must never run inside the developer's own database. It derives a
 * sibling database (same server, name suffixed `_e2e`) and owns that
 * one outright; scripts/db-setup.ts creates it on first use.
 */
export function baseUrlToE2eUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const database = url.pathname.replace(/^\//, "");
  if (database === "") {
    throw new Error(
      `DATABASE_URL names no database (empty path): ${databaseUrl}. ` +
        "Expected e.g. postgres://localhost:5432/workbench.",
    );
  }
  url.pathname = `/${database}_e2e`;
  return url.toString();
}
