#!/usr/bin/env bun

/**
 * Times the phases of opening a chat and connecting to Myra against a running
 * hub: `GET /v1/me` (identity), `GET /v1/tenants/:tenant/me/myra/threads`
 * (thread list), and `POST /instances/:id/sessions` (launch/warm-path). Uses
 * an authenticated cookie jar the same way the other operator scripts do
 * (see `_lib.ts`), so it exercises the real hub routes rather than mocking
 * them — a mechanism-level estimate is a fallback for when this cannot be run
 * against a live environment, not a substitute for it.
 *
 * Usage:
 *   HUB_BASE=https://staging.example.com \
 *   HUB_COOKIE="better-auth.session_token=..." \
 *   INSTANCE_ID=inst_xxx \
 *   TENANT_ID=tnt_xxx \
 *   bun apps/hub/bin/probe-launch-latency.ts [--runs 5]
 *
 * `HUB_COOKIE` is the raw `Cookie` header value from an authenticated browser
 * session (copy it from devtools) — this script does not perform its own
 * login flow. Prints per-phase timings for each run plus p50/p95 across runs.
 */

import { parseArgs } from "node:util";
import { api, env, makeLogger, type CookieJar } from "./_lib";

const log = makeLogger("probe-launch-latency");

type PhaseTimings = {
  identity: number;
  threads: number;
  launch: number;
  total: number;
};

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)] ?? 0;
}

async function timedRun(
  base: string,
  cookies: CookieJar,
  tenantId: string,
  instanceId: string,
): Promise<PhaseTimings> {
  const totalStart = performance.now();

  const identityStart = performance.now();
  const meRes = await api(base, "GET", "/api/v1/me", undefined, cookies);
  const identity = performance.now() - identityStart;
  if (meRes.status !== 200) {
    throw new Error(`GET /v1/me returned ${meRes.status}`);
  }

  const threadsStart = performance.now();
  const threadsRes = await api(
    base,
    "GET",
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/me/myra/threads?limit=1`,
    undefined,
    cookies,
  );
  const threads = performance.now() - threadsStart;
  if (threadsRes.status !== 200) {
    throw new Error(`GET myra/threads returned ${threadsRes.status}`);
  }

  const launchStart = performance.now();
  const launchRes = await api(
    base,
    "POST",
    `/api/instances/${encodeURIComponent(instanceId)}/sessions`,
    {},
    cookies,
  );
  const launch = performance.now() - launchStart;
  if (launchRes.status !== 200) {
    throw new Error(`POST instances/sessions returned ${launchRes.status}`);
  }

  return { identity, threads, launch, total: performance.now() - totalStart };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { runs: { type: "string", default: "5" } },
  });
  const runs = Number.parseInt(values.runs ?? "5", 10);
  if (!Number.isFinite(runs) || runs < 1) {
    throw new Error("probe-launch-latency: --runs must be a positive integer");
  }

  const base = env("HUB_BASE");
  const cookieHeader = env("HUB_COOKIE");
  const tenantId = env("TENANT_ID");
  const instanceId = env("INSTANCE_ID");
  if (!base || !cookieHeader || !tenantId || !instanceId) {
    throw new Error(
      "probe-launch-latency: HUB_BASE, HUB_COOKIE, TENANT_ID, and INSTANCE_ID are all required",
    );
  }
  const cookies: CookieJar = [cookieHeader];

  const results: PhaseTimings[] = [];
  for (let i = 0; i < runs; i++) {
    const timing = await timedRun(base, cookies, tenantId, instanceId);
    results.push(timing);
    log(
      `run ${i + 1}/${runs}: identity=${timing.identity.toFixed(0)}ms ` +
        `threads=${timing.threads.toFixed(0)}ms launch=${timing.launch.toFixed(0)}ms ` +
        `total=${timing.total.toFixed(0)}ms`,
    );
  }

  const totals = results.map((r) => r.total);
  log(
    `p50 total=${percentile(totals, 50).toFixed(0)}ms ` +
      `p95 total=${percentile(totals, 95).toFixed(0)}ms`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
