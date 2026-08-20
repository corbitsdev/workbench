/**
 * Manual smoke test for the connect-github host bindings (CL-6344):
 * connect a real PAT, list repos, and start reviewing one, against a
 * running local hub.
 *
 * Never prints or commits the token. Reads it from `GITHUB_TOKEN`, or
 * falls back to `gh auth token` if that env var is unset.
 *
 * Required env:
 *   HUB_URL        e.g. http://localhost:3000
 *   TENANT_ID       an existing tenant id this session can act as
 *   WORKBENCH_ID    a workbench minted from the "code-review" template
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
  const workbenchId = requireEnv("WORKBENCH_ID");
  const cookie = requireEnv("COOKIE");
  const token = readToken();

  const headers = {
    "content-type": "application/json",
    cookie,
  };

  console.log("== connect ==");
  const connectRes = await fetch(
    `${hubUrl}/api/tenants/${tenantId}/connections/github/complete`,
    { method: "POST", headers, body: JSON.stringify({ apiKey: token }) },
  );
  console.log(connectRes.status, await connectRes.text());
  if (!connectRes.ok) return;

  console.log("== state ==");
  const stateRes = await fetch(
    `${hubUrl}/api/tenants/${tenantId}/workbenches/${workbenchId}/github/state`,
    { headers },
  );
  const state = (await stateRes.json()) as {
    kind: string;
    repos?: { id: string; name: string }[];
  };
  console.log(stateRes.status, state);
  if (state.kind !== "connected" || state.repos === undefined) return;

  const firstRepo = state.repos[0];
  if (firstRepo === undefined) {
    console.log("no repos to review — stopping here");
    return;
  }

  console.log(`== start-reviewing ${firstRepo.name} ==`);
  const startRes = await fetch(
    `${hubUrl}/api/tenants/${tenantId}/workbenches/${workbenchId}/github/start-reviewing`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ repoIds: [firstRepo.id] }),
    },
  );
  console.log(startRes.status, await startRes.text());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
