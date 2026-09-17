/**
 * Manual smoke test for the GitHub connect binding (hub-zero T3
 *): connects a real PAT through the native tenant-scoped
 * `connections/github/complete` route against a running local hub.
 *
 * Hub-zero T3 deleted the workbench-scoped `github/state` and
 * `github/start-reviewing` routes with no native equivalent yet, so this
 * smoke stops after a successful connect — the card's repo-pick
 * walkthrough rebind is a connections follow-up.
 *
 * Never prints or commits the token. Reads it from `GITHUB_TOKEN`, or
 * falls back to `gh auth token` if that env var is unset.
 *
 * Required env:
 *   HUB_URL        e.g. http://localhost:3000
 *   TENANT_ID       an existing tenant id this session can act as
 *   COOKIE          the session cookie header value for an authenticated
 *                   request (copy from a logged-in browser session)
 *
 * Run: bun run scripts/repro/connect-github-smoke.ts
 */
import { spawnSync } from "node:child_process";

function readToken(): string {
  const fromEnv = process.env["GITHUB_TOKEN"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (result.status !== 0 || result.stdout.trim() === "") {
    throw new Error(
      "No GITHUB_TOKEN in env and `gh auth token` failed — set one or run `gh auth login`.",
    );
  }
  return result.stdout.trim();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  const hubUrl = requireEnv("HUB_URL");
  const tenantId = requireEnv("TENANT_ID");
  const cookie = requireEnv("COOKIE");
  const token = readToken();

  const headers = {
    "content-type": "application/json",
    cookie,
  };

  console.log("== connect (native connections route) ==");
  const connectRes = await fetch(`${hubUrl}/api/tenants/${tenantId}/connections/github/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ apiKey: token }),
  });
  console.log(connectRes.status, await connectRes.text());
  if (!connectRes.ok) {
    throw new Error("connect failed — see status above");
  }
  // `github/state` and `github/start-reviewing` no longer exist, so
  // there is nothing further to smoke until the connections follow-up
  // lands the native rebind.
  console.log("connected — state/start-reviewing walkthrough deleted");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
